/**
 * One account's data, reached with another account's credentials.
 *
 * devices, relay, panel-host and account tests already cover the routes that
 * take an id in the path or a form (/devices/:id/revoke, /p/:device, the
 * deletion form). These cover the rest: the routes that take no id at all
 * and scope by the caller, where the failure to fear is a query that forgot
 * its account_id, and the one route that takes an id in the body
 * (/proxy/assistant's session_id). Each test gives two accounts the same
 * shape of data and checks that neither can see, spend, or change the
 * other's.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { encrypt } from "../src/crypto";
import { claimDevice, get, ORIGIN, postForm, postJson } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const bearer = (token: string) => ({ Authorization: "Bearer " + token });

function put(path: string, body: unknown, token: string) {
  return SELF.fetch(ORIGIN + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
}

/** Two accounts, each with a claimed Mac on the same profile. */
async function twoAccounts(tag: string) {
  const a = await claimDevice(`${tag}-a@example.com`);
  const b = await claimDevice(`${tag}-b@example.com`);
  expect(a.account.id).not.toBe(b.account.id);
  return { a, b };
}

/** Any outbound call, recorded and refused, so a test can assert none was made. */
function noOutbound() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 500 });
    }),
  );
  return calls;
}

describe("settings documents", () => {
  it("are read per account, even under the same profile and name", async () => {
    const { a, b } = await twoAccounts("settings-read");
    expect((await put("/settings/schedule", { content: "A's schedule" }, a.token)).status).toBe(200);

    const theirs = await get("/settings/schedule", bearer(b.token));
    expect(theirs.status).toBe(404);

    expect((await put("/settings/schedule", { content: "B's schedule" }, b.token)).status).toBe(200);
    const mine = (await (await get("/settings/schedule", bearer(a.token))).json()) as { content: string; updated_by: string };
    expect(mine.content).toBe("A's schedule");
    expect(mine.updated_by).toBe(a.deviceId);
  });

  it("cannot be overwritten by another account holding the right updated_at", async () => {
    const { a, b } = await twoAccounts("settings-write");
    const written = (await (await put("/settings/schedule", { content: "A's" }, a.token)).json()) as { updated_at: string };

    // B knows A's exact version stamp; that is not a key to A's row.
    const res = await put("/settings/schedule", { content: "B's", expected_updated_at: written.updated_at }, b.token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { current: unknown }).current).toBeNull();

    const row = await db.getSetting(env.DB, a.account.id, "syllabus", "schedule");
    expect(row!.content).toBe("A's");
  });
});

describe("a Drive grant", () => {
  async function connectDrive(accountId: string, email: string) {
    await db.putDriveGrant(env.DB, accountId, await encrypt(env.DRIVE_KEY, "1//refresh-" + accountId), "drive.file", email);
  }

  it("is never used to mint a token for another account's Mac", async () => {
    const { a, b } = await twoAccounts("drive-token");
    await connectDrive(a.account.id, "a@gmail.com");
    const calls = noOutbound();

    const res = await postJson("/drive/token", {}, bearer(b.token));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_grant");
    // Refused before Google was asked, so A's refresh token never left the vault.
    expect(calls).toEqual([]);
  });

  it("does not show in another account's status, by token or by browser", async () => {
    const { a, b } = await twoAccounts("drive-status");
    await connectDrive(a.account.id, "a-status@gmail.com");
    for (const headers of [bearer(b.token), { Cookie: b.cookie }]) {
      const text = await (await get("/drive/status", headers)).text();
      expect(JSON.parse(text).connected).toBe(false);
      expect(text).not.toContain("a-status@gmail.com");
    }
  });

  it("survives another account disconnecting its own", async () => {
    const { a, b } = await twoAccounts("drive-disconnect");
    await connectDrive(a.account.id, "a@gmail.com");
    await connectDrive(b.account.id, "b@gmail.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    expect((await postForm("/drive/disconnect", {}, { Cookie: b.cookie })).status).toBe(302);
    expect(await db.driveGrant(env.DB, b.account.id)).toBeNull();
    expect((await db.driveGrant(env.DB, a.account.id))!.google_email).toBe("a@gmail.com");
  });
});

describe("the month's usage", () => {
  it("is counted and reported per account", async () => {
    const { a, b } = await twoAccounts("usage");
    await db.putAllowance(env.DB, a.account.id, { audio_seconds: 36_000, summary_tokens: 500_000, assistant_sessions: 0, source: "test" });
    await db.putAllowance(env.DB, b.account.id, { audio_seconds: 36_000, summary_tokens: 500_000, assistant_sessions: 0, source: "test" });
    await db.recordUsage(env.DB, a.account.id, a.deviceId, "transcribe", 7_200);

    const theirs = (await (await get("/proxy/usage", bearer(b.token))).json()) as { audio_seconds: { used: number; left: number } };
    expect(theirs.audio_seconds).toMatchObject({ used: 0, left: 36_000 });
    const mine = (await (await get("/proxy/usage", bearer(a.token))).json()) as { audio_seconds: { used: number } };
    expect(mine.audio_seconds.used).toBe(7_200);
  });
});

describe("a study session", () => {
  const SUMMARIES = [{ title: "ACCT-4321 2026-09-15: Job Order Costing", context: "Summary.", body: "Jobs carry their own costs." }];

  async function pro(accountId: string) {
    await db.putAllowance(env.DB, accountId, { audio_seconds: 45 * 3600, summary_tokens: 1_350_000, assistant_sessions: 15, source: "pro" });
  }

  async function openFor(accountId: string, deviceId: string) {
    const id = "sess-" + accountId;
    await env.DB.prepare("INSERT INTO assistant_sessions (id, account_id, device_id, period, opened_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, accountId, deviceId, db.usagePeriod(), new Date().toISOString())
      .run();
    return id;
  }

  const rowOf = (id: string) =>
    env.DB.prepare("SELECT account_id, questions, escalations, spent FROM assistant_sessions WHERE id = ?").bind(id).first();

  it("cannot be carried on by another account that learns its id", async () => {
    const { a, b } = await twoAccounts("assistant-q");
    await pro(a.account.id);
    await pro(b.account.id);
    const id = await openFor(a.account.id, a.deviceId);
    const before = await rowOf(id);
    const calls = noOutbound();

    const res = await postJson("/proxy/assistant", { session_id: id, question: "q", summaries: SUMMARIES }, bearer(b.token));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "session_ended", reason: "unknown_session" });
    // Refused before the provider was called, and A's session is exactly as it was.
    expect(calls).toEqual([]);
    expect(await rowOf(id)).toEqual(before);
    expect(await db.assistantSessionsThisPeriod(env.DB, b.account.id)).toBe(0);
  });

  it("cannot be escalated by another account either", async () => {
    const { a, b } = await twoAccounts("assistant-esc");
    await pro(a.account.id);
    await pro(b.account.id);
    const id = await openFor(a.account.id, a.deviceId);
    await env.DB.prepare("UPDATE assistant_sessions SET questions = 1 WHERE id = ?").bind(id).run();
    const before = await rowOf(id);
    const calls = noOutbound();

    const res = await postJson(
      "/proxy/assistant",
      {
        session_id: id,
        question: "q",
        summaries: SUMMARIES,
        continuation: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_1", name: "fetch_transcripts", input: { lectures: [] } }],
        transcripts: [{ title: "t", context: "c", body: "b" }],
      },
      bearer(b.token),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "session_ended", reason: "unknown_session" });
    expect(calls).toEqual([]);
    expect(await rowOf(id)).toEqual(before);
  });
});

describe("two credentials on one request", () => {
  it("acts as the device token's account, never a blend of the two", async () => {
    const { a, b } = await twoAccounts("mixed");
    const me = (await (await get("/me", { ...bearer(a.token), Cookie: b.cookie })).json()) as {
      account: { id: string; email: string };
      device: { id: string };
    };
    expect(me.account.id).toBe(a.account.id);
    expect(me.account.email).toBe(a.account.email);
    expect(me.device.id).toBe(a.deviceId);
  });

  it("does not fall back to the cookie when the token is dead", async () => {
    const { a, b } = await twoAccounts("mixed-dead");
    expect((await postJson("/device/revoke", {}, bearer(a.token))).status).toBe(200);
    const res = await get("/me", { ...bearer(a.token), Cookie: b.cookie });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });
});

describe("ending one account's access", () => {
  it("leaves another account's Mac, settings and Drive working", async () => {
    const { a, b } = await twoAccounts("revoke-all");
    await put("/settings/schedule", { content: "B's" }, b.token);
    await db.putDriveGrant(env.DB, b.account.id, await encrypt(env.DRIVE_KEY, "1//b"), "drive.file", "b@gmail.com");

    expect((await postForm("/devices/revoke-all", {}, { Cookie: a.cookie })).status).toBe(302);
    expect((await get("/me", bearer(a.token))).status).toBe(401);

    expect((await get("/me", bearer(b.token))).status).toBe(200);
    expect(((await (await get("/settings/schedule", bearer(b.token))).json()) as { content: string }).content).toBe("B's");
    expect(await db.driveGrant(env.DB, b.account.id)).not.toBeNull();
  });

  it("will not delete the account whose email is typed if it is not the signed-in one", async () => {
    const { a, b } = await twoAccounts("delete-other");
    const res = await postForm("/account/delete", { confirm_email: b.account.email }, { Cookie: a.cookie });
    expect(res.status).toBe(400);
    expect(await db.accountById(env.DB, a.account.id)).not.toBeNull();
    expect(await db.accountById(env.DB, b.account.id)).not.toBeNull();
    expect((await get("/me", bearer(b.token))).status).toBe(200);
  });
});
