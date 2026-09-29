import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs ops script, no types
import { bulkRevoke, confirmationPhrase, keyId as scriptKeyId, parseLedger, unseal as scriptUnseal } from "../scripts/bulk-revoke-lib.mjs";
import { encrypt } from "../src/crypto";
import { putDriveGrant } from "../src/db";
import { sealGrant } from "../src/drive-keys";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { mintTicket, PANEL_COOKIE } from "../src/panel-host";
import { claimDevice, ORIGIN } from "./helpers";

// The tool's own logic, against the real (test) D1, with a stand-in for
// Google. Nothing here reaches a real database or the real Google.

type Q = { rows: Record<string, unknown>[]; changes: number };
type Db = { query(sql: string, params: unknown[]): Promise<Q> };

const KEYS = { DRIVE_KEY: env.DRIVE_KEY, DRIVE_KEY_PREVIOUS: env.DRIVE_KEY_PREVIOUS ?? "" };

function d1(): Db {
  return {
    async query(sql, params) {
      const r = await env.DB.prepare(sql).bind(...params).all();
      return { rows: r.results as Record<string, unknown>[], changes: r.meta.changes ?? 0 };
    },
  };
}

/** A Google that records every token it is asked to revoke, and answers as told. */
function fakeGoogle(answer: (token: string) => number | Error | { status: number; body: unknown } = () => 200) {
  const calls: string[] = [];
  const fn = async (_url: string, init: RequestInit) => {
    const token = new URLSearchParams(String(init.body)).get("token") ?? "";
    calls.push(token);
    const a = answer(token);
    if (a instanceof Error) throw a;
    const status = typeof a === "number" ? a : a.status;
    const body = typeof a === "number" ? {} : a.body;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fn, calls };
}

type Person = Awaited<ReturnType<typeof claimDevice>> & { refresh: string };

async function person(n: number, withGrant = true): Promise<Person> {
  const p = await claimDevice(`person${n}@example.com`, `Mac ${n}`);
  const refresh = `1//refresh-token-for-person-${n}-abcdefghijklmnop`;
  if (withGrant) await putDriveGrant(env.DB, p.account.id, await sealGrant(env, refresh), "drive.file", `person${n}@example.com`);
  return { ...p, refresh };
}

/** Everything a run must leave alone or change, as plain data. */
async function snapshot() {
  const q = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return JSON.stringify([
    await q("SELECT * FROM accounts ORDER BY id"),
    await q("SELECT * FROM devices ORDER BY id"),
    await q("SELECT * FROM device_tokens ORDER BY token_hash"),
    await q("SELECT * FROM drive_grants ORDER BY account_id"),
    await q("SELECT * FROM panel_tickets ORDER BY nonce"),
  ]);
}

const version = async (id: string) =>
  (await env.DB.prepare("SELECT token_version AS v FROM accounts WHERE id = ?").bind(id).first<{ v: number }>())!.v;
const grantIds = async () =>
  (await env.DB.prepare("SELECT account_id FROM drive_grants ORDER BY account_id").all<{ account_id: string }>()).results.map((r) => r.account_id);

/** Run the tool. `typed` is what the operator types; by default the right phrase. */
function run(options: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const log: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const done: Set<string> = (extra.done as Set<string>) ?? new Set();
  const google = (extra.google as ReturnType<typeof fakeGoogle>) ?? fakeGoogle();
  const prompts: string[] = [];
  const deps = {
    db: (extra.db as Db) ?? d1(),
    fetch: google.fn,
    keys: KEYS,
    done,
    append: async (row: Record<string, unknown>) => void log.push(row),
    prompt: async (text: string) => {
      prompts.push(text);
      return (extra.typed as string | undefined) ?? confirmationPhrase(extra.expect as number);
    },
    out: (l: string) => void lines.push(l),
    sleep: async (_ms: number) => {},
    now: extra.now as (() => number) | undefined,
  };
  return { deps, log, lines, done, google, prompts, go: () => bulkRevoke(deps, { runId: "t1", ...options }) };
}

/** A run that types the right confirmation for `n` accounts. */
const runFor = (n: number, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  run({ execute: true, ...options }, { expect: n, ...extra });

async function setSessionColumn(present: boolean) {
  const cols = (await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>()).results;
  const has = cols.some((c) => c.name === "session_version");
  if (present && !has) await env.DB.exec("ALTER TABLE accounts ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
  if (!present && has) await env.DB.exec("ALTER TABLE accounts DROP COLUMN session_version");
  return has;
}

let hadColumn = false;
beforeEach(async () => {
  // Storage is shared between the tests of a file, and this tool works on every account there is.
  for (const t of ["drive_grants", "panel_tickets", "device_codes", "device_tokens", "devices", "accounts"]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  hadColumn = await setSessionColumn(false);
});
afterEach(async () => {
  await setSessionColumn(hadColumn);
});

const drive = (token: string) => SELF.fetch(ORIGIN + "/drive/status", { headers: { Authorization: "Bearer " + token, "CF-Connecting-IP": "203.0.113.9" } });

describe("bulk revoke: a dry run", () => {
  it("changes nothing, calls nobody and writes no audit line, and says what a run would do", async () => {
    const a = await person(1);
    await person(2);
    const before = await snapshot();
    const r = run({ execute: false }, { expect: 2 });
    const out = await r.go();
    expect(await snapshot()).toBe(before);
    expect(r.google.calls).toEqual([]);
    expect(r.log).toEqual([]);
    expect(r.prompts).toEqual([]);
    expect(out.executed).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("2 found");
    expect(text).toContain("2 device(s), 2 device token(s)");
    expect(text).toContain("Drive grants to revoke: 2 (2 open with the keys given, 0 do not)");
    expect((await drive(a.token)).status).toBe(200);
  });

  it("is the default: execute has to be asked for", async () => {
    await person(1);
    const r = run({}, { expect: 1 });
    await r.go();
    expect(r.prompts).toEqual([]);
    expect(await grantIds()).toHaveLength(1);
  });
});

describe("bulk revoke: --execute", () => {
  it("ends every device token, panel cookie, and Drive grant, and revokes each grant at Google with the plain token", async () => {
    const a = await person(1);
    const b = await person(2);
    const c = await person(3, false);
    expect((await drive(a.token)).status).toBe(200);
    const r = runFor(3);
    const out = await r.go();
    expect(out.executed).toBe(true);
    // Device tokens: gone, at the Worker's own door.
    for (const p of [a, b, c]) expect((await drive(p.token)).status).toBe(401);
    expect(await version(a.account.id)).toBe(1);
    const devices = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").first<{ n: number }>();
    const tokens = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_tokens WHERE revoked_at IS NULL").first<{ n: number }>();
    expect(devices!.n).toBe(0);
    expect(tokens!.n).toBe(0);
    // Google was asked for exactly the two refresh tokens, and the ciphertext is gone.
    expect(r.google.calls.sort()).toEqual([a.refresh, b.refresh].sort());
    expect(await grantIds()).toEqual([]);
    expect(out.grants).toMatchObject({ revoked: 2, none: 1, failed: 0 });
    expect(r.lines.join("\n")).toContain("2 revoked at Google");
  });

  it("is idempotent: the same run again changes and calls nothing", async () => {
    const a = await person(1);
    await person(2);
    const first = runFor(2);
    await first.go();
    const after = await snapshot();
    const again = runFor(2, {}, { done: first.done });
    const out = await again.go();
    expect(await snapshot()).toBe(after);
    expect(again.google.calls).toEqual([]);
    expect(await version(a.account.id)).toBe(1);
    expect(out.tokensDone).toBe(0);
  });

  it("a new run id is a new incident and does it all again", async () => {
    const a = await person(1);
    await runFor(1).go();
    await runFor(1, { runId: "t2" }, { done: new Set() }).go();
    expect(await version(a.account.id)).toBe(2);
  });

  it("resumes after a crash in the middle, without bumping anyone twice or calling Google twice", async () => {
    const people = [await person(1), await person(2), await person(3), await person(4), await person(5)];
    const real = d1();
    let bumps = 0;
    const flaky: Db = {
      async query(sql, params) {
        if (sql.startsWith("UPDATE accounts SET token_version") && ++bumps === 2) throw new Error("D1 went away");
        return real.query(sql, params);
      },
    };
    const first = runFor(5, { batchSize: 2 }, { db: flaky });
    await expect(first.go()).rejects.toThrow("D1 went away");
    // The first batch was finished and recorded before the crash.
    expect(first.done.has(`${[...people.map((p) => p.account.id)].sort()[0]}:tokens`)).toBe(true);
    const google = fakeGoogle();
    const second = runFor(5, { batchSize: 2 }, { done: first.done, google });
    const out = await second.go();
    expect(out.failures).toEqual([]);
    for (const p of people) expect(await version(p.account.id)).toBe(1);
    expect(await grantIds()).toEqual([]);
    // Google heard about every refresh token exactly once across both runs.
    expect([...first.google.calls, ...google.calls].sort()).toEqual(people.map((p) => p.refresh).sort());
  });

  it("carries on past a Google failure, records it, keeps that grant stored, and retries only it next time", async () => {
    const a = await person(1);
    const b = await person(2);
    const c = await person(3);
    const google = fakeGoogle((t) => (t === b.refresh ? 503 : 200));
    const first = runFor(3, {}, { google });
    const out = await first.go();
    expect(out.failures).toEqual([{ account: b.account.id, code: "google_503" }]);
    expect(await grantIds()).toEqual([b.account.id]);
    // The tokens were revoked regardless: a Google outage does not hold up the rest.
    for (const p of [a, b, c]) expect((await drive(p.token)).status).toBe(401);
    expect(first.log.filter((l) => l.event === "step" && l.ok === false)).toEqual([
      expect.objectContaining({ account: b.account.id, step: "grant", code: "google_503" }),
    ]);
    expect(google.calls.filter((t) => t === b.refresh)).toHaveLength(3); // tried three times, then gave up
    // A healthy Google, same run id: only the failed one is touched.
    const healthy = fakeGoogle();
    const retry = runFor(3, {}, { done: first.done, google: healthy });
    const again = await retry.go();
    expect(healthy.calls).toEqual([b.refresh]);
    expect(again.failures).toEqual([]);
    expect(await grantIds()).toEqual([]);
    expect(await version(a.account.id)).toBe(1);
  });

  it("treats a grant Google already refuses as done, and one neither key opens as a failure that keeps the row", async () => {
    const a = await person(1);
    const b = await person(2);
    const c = await person(3, false);
    await putDriveGrant(env.DB, c.account.id, await encrypt("some-key-nobody-has-any-more", "1//lost"), "drive.file", "x");
    const google = fakeGoogle((t) => (t === a.refresh ? { status: 400, body: { error: "invalid_token" } } : 200));
    const r = runFor(3, {}, { google });
    const out = await r.go();
    expect(out.grants).toMatchObject({ already_invalid: 1, revoked: 1, unreadable: 1 });
    expect(out.failures).toEqual([{ account: c.account.id, code: "unreadable" }]);
    expect(await grantIds()).toEqual([c.account.id]);
    expect(google.calls).not.toContain("1//lost");
    expect(b.refresh).toBeTruthy();
  });

  it("deletes only the grant it read, so a Drive connected while the run is going is not thrown away", async () => {
    const a = await person(1);
    const google = fakeGoogle();
    const slow = async (url: string, init: RequestInit) => {
      // The person reconnects Drive in the middle of the revoke call.
      await putDriveGrant(env.DB, a.account.id, await sealGrant(env, "1//reconnected"), "drive.file", "x");
      return google.fn(url, init);
    };
    const r = runFor(1);
    r.deps.fetch = slow as never;
    await r.go();
    expect(await grantIds()).toEqual([a.account.id]);
  });

  it("does not treat any other 400 as success", async () => {
    const a = await person(1);
    const r = runFor(1, {}, { google: fakeGoogle(() => ({ status: 400, body: { error: "invalid_request" } })) });
    const out = await r.go();
    expect(out.failures).toEqual([{ account: a.account.id, code: "google_400" }]);
    expect(await grantIds()).toEqual([a.account.id]);
  });

  it("opens a grant sealed under the previous key while a rotation is under way", async () => {
    const a = await person(1, false);
    await putDriveGrant(env.DB, a.account.id, await encrypt(env.DRIVE_KEY_PREVIOUS!, "1//old-key-token"), "drive.file", "x");
    const r = runFor(1);
    await r.go();
    expect(r.google.calls).toEqual(["1//old-key-token"]);
  });

  it("paces the calls to Google", async () => {
    await person(1);
    await person(2);
    await person(3);
    let t = 1_000_000;
    const slept: number[] = [];
    const r = runFor(3, { perSecond: 2 }, { now: () => t });
    r.deps.sleep = async (ms: number) => void (slept.push(ms), (t += ms));
    await r.go();
    // Two calls per second means 500 ms between calls: none before the first, then two waits.
    expect(slept).toEqual([500, 500]);
  });

  it("refuses to start without DRIVE_KEY unless told to leave Drive alone", async () => {
    const a = await person(1);
    const r = runFor(1);
    r.deps.keys = null as never;
    await expect(r.go()).rejects.toThrow("DRIVE_KEY is not in the environment");
    const skip = runFor(1, { skipDrive: true }, {});
    skip.deps.keys = null as never;
    await skip.go();
    expect(await grantIds()).toEqual([a.account.id]);
    expect((await drive(a.token)).status).toBe(401);
  });
});

describe("bulk revoke: --only", () => {
  it("touches the chosen accounts and no others", async () => {
    const a = await person(1);
    const b = await person(2);
    const c = await person(3);
    const before = new Map<string, string>();
    for (const p of [b, c]) {
      before.set(p.account.id, JSON.stringify(await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(p.account.id).first()));
    }
    const r = runFor(1, { only: [a.account.id, "no-such-account"] });
    const out = await r.go();
    expect(out.missing).toEqual(["no-such-account"]);
    expect(r.google.calls).toEqual([a.refresh]);
    expect((await drive(a.token)).status).toBe(401);
    for (const p of [b, c]) {
      expect((await drive(p.token)).status).toBe(200);
      expect(JSON.stringify(await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(p.account.id).first())).toBe(before.get(p.account.id));
    }
    expect(await grantIds()).toEqual([b.account.id, c.account.id].sort());
    expect(new Set(r.log.filter((l) => l.event === "step").map((l) => l.account))).toEqual(new Set([a.account.id]));
  });

  it("refuses anything that is not an account id", async () => {
    await expect(run({ execute: true, only: ["a'; DROP TABLE accounts;--"] }).go()).rejects.toThrow("not an account id");
  });
});

describe("bulk revoke: browser sessions (accounts.session_version, migration 0017)", () => {
  const sessionVersion = async (id: string) =>
    (await env.DB.prepare("SELECT session_version AS v FROM accounts WHERE id = ?").bind(id).first<{ v: number }>())!.v;

  it("bumps session_version when the column exists", async () => {
    await setSessionColumn(true);
    const a = await person(1);
    const b = await person(2);
    const r = runFor(2);
    const out = await r.go();
    expect(out.sessionsSupported).toBe(true);
    expect(await sessionVersion(a.account.id)).toBe(1);
    expect(await sessionVersion(b.account.id)).toBe(1);
    // token_version and session_version move together, as in revokeEverything.
    expect(await version(a.account.id)).toBe(1);
  });

  it("with --only, bumps only the chosen account", async () => {
    await setSessionColumn(true);
    const a = await person(1);
    const b = await person(2);
    await runFor(1, { only: [a.account.id] }).go();
    expect(await sessionVersion(a.account.id)).toBe(1);
    expect(await sessionVersion(b.account.id)).toBe(0);
  });

  it("skips cleanly, and says so, when the column does not exist", async () => {
    const a = await person(1);
    const r = runFor(1);
    const out = await r.go();
    expect(out.sessionsSupported).toBe(false);
    expect(out.sessionsSkipped).toBe(1);
    expect(await version(a.account.id)).toBe(1);
    expect(r.lines.join("\n")).toContain("browser sessions are NOT invalidated");
    expect(r.log.some((l) => l.step === "sessions")).toBe(false);
  });

  it("finishes the sessions later, once the column exists, without bumping the tokens again", async () => {
    const a = await person(1);
    const first = runFor(1);
    await first.go();
    await setSessionColumn(true);
    const second = runFor(1, {}, { done: first.done });
    const out = await second.go();
    expect(out.tokensDone).toBe(0);
    expect(out.sessionsBumped).toBe(1);
    expect(await version(a.account.id)).toBe(1);
    expect(await sessionVersion(a.account.id)).toBe(1);
  });
});

describe("bulk revoke: confirmation", () => {
  it("aborts on a wrong confirmation and changes nothing", async () => {
    const a = await person(1);
    await person(2);
    const before = await snapshot();
    for (const typed of ["", "yes", "REVOKE 1 ACCOUNTS", "revoke 2 accounts"]) {
      const r = runFor(2, {}, { typed });
      const out = await r.go();
      expect(out.aborted).toBe(true);
      expect(out.executed).toBe(false);
      expect(r.log).toEqual([]);
      expect(r.google.calls).toEqual([]);
    }
    expect(await snapshot()).toBe(before);
    expect((await drive(a.token)).status).toBe(200);
  });

  it("asks for a phrase that names how many accounts", () => {
    expect(confirmationPhrase(42)).toBe("REVOKE 42 ACCOUNTS");
  });
});

describe("bulk revoke: the audit log", () => {
  it("names accounts and steps, and holds no email, token, refresh token, key or name", async () => {
    await setSessionColumn(true);
    const people = [await person(1), await person(2)];
    const r = runFor(2, {}, { google: fakeGoogle((t) => (t === people[1].refresh ? 500 : 200)) });
    await r.go();
    const text = JSON.stringify(r.log) + "\n" + r.lines.join("\n");
    for (const p of people) {
      expect(text).not.toContain(p.token);
      expect(text).not.toContain(p.refresh);
      expect(text).not.toContain(p.account.email);
    }
    expect(text).not.toMatch(/@|syd_|1\/\/|test-drive-key|test-session-secret|Test Person|Mac \d/);
    // Only these fields ever appear, so a new one has to be added here on purpose.
    const allowed = new Set(["event", "run", "at", "account", "step", "ok", "code", "scope", "accounts", "sessions_supported", "skip_drive", "failures"]);
    for (const line of r.log) for (const k of Object.keys(line)) expect(allowed.has(k)).toBe(true);
    expect(r.log[0]).toMatchObject({ event: "run_start", accounts: 2 });
    expect(r.log.at(-1)).toMatchObject({ event: "run_end", failures: 1 });
    // And a ledger read back from those lines is what resumes.
    const ledger = parseLedger(r.log.map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
    expect(ledger.has(`${people[0].account.id}:grant`)).toBe(true);
    expect(ledger.has(`${people[1].account.id}:grant`)).toBe(false);
  });
});

describe("bulk revoke: panel tickets and cookies", () => {
  const PANEL = "https://panels.example";
  const call = (url: string, init: RequestInit = {}) =>
    worker.fetch(new Request(url, { redirect: "manual", ...init }), { ...(env as unknown as Bindings), PANEL_ORIGIN: PANEL }, createExecutionContext());

  async function panelCookieFor(p: Person) {
    const handed = await call(`${ORIGIN}/p/${p.deviceId}/`, { headers: { Cookie: p.cookie } });
    const auth = await call(handed.headers.get("Location")!);
    return (auth.headers.get("Set-Cookie") ?? "").split(";")[0];
  }

  it("a panel cookie issued before the run, and a ticket minted before it, are both dead after", async () => {
    const p = await person(1);
    const cookie = await panelCookieFor(p);
    expect(cookie.startsWith(PANEL_COOKIE + "=")).toBe(true);
    const viewing = () => call(`${PANEL}/p/${p.deviceId}/api/x`, { headers: { Cookie: cookie } });
    expect((await viewing()).status).not.toBe(401);
    const ticket = await mintTicket(env.SESSION_SECRET, p.account.id, p.deviceId, "/");
    await runFor(1).go();
    expect((await viewing()).status).toBe(401);
    const spent = await call(`${PANEL}/p/${p.deviceId}/_auth?t=${encodeURIComponent(ticket)}`);
    expect(spent.status).toBe(403);
    expect(spent.headers.get("Set-Cookie")).toBeNull();
  });

  it("leaves spent-ticket records alone, because deleting them would let a spent ticket be used again", async () => {
    const p = await person(1);
    await env.DB.prepare("INSERT INTO panel_tickets (nonce, expires_at) VALUES ('n1', '2999-01-01T00:00:00.000Z')").run();
    await runFor(1).go();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM panel_tickets").first<{ n: number }>())!.n).toBe(1);
    expect(p.deviceId).toBeTruthy();
  });
});

describe("bulk revoke: opening grants the way the Worker does", () => {
  it("opens what the Worker seals, current key, previous key, and a value from before key ids", async () => {
    expect(await scriptUnseal(KEYS, await sealGrant(env, "1//now"))).toBe("1//now");
    expect(await scriptUnseal(KEYS, await encrypt(env.DRIVE_KEY_PREVIOUS!, "1//before"))).toBe("1//before");
    const legacy = (await encrypt(env.DRIVE_KEY, "1//legacy")).split(".").slice(0, 2).join(".");
    expect(await scriptUnseal(KEYS, legacy)).toBe("1//legacy");
    await expect(scriptUnseal(KEYS, await encrypt("another key", "1//no"))).rejects.toBeTruthy();
  });

  it("computes the same key id as the Worker", async () => {
    expect(await scriptKeyId("new-key")).toBe("c8cc8b7f");
    expect((await sealGrant(env, "x")).endsWith("." + (await scriptKeyId(env.DRIVE_KEY)))).toBe(true);
  });
});
