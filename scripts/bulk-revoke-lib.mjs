/**
 * The logic of the bulk revoke tool (scripts/bulk-revoke.mjs), with nothing
 * in it that touches the machine: no files, no environment, no process. The
 * database, the network, the clock, the keys and the audit log are all handed
 * in, which is what lets test/bulk-revoke.test.ts run the real logic against
 * the test D1 with a stand-in for Google. It also has to import nothing from
 * node:, because the tests run in the Workers pool.
 *
 * What one run does to an account, in this order:
 *
 *   tokens    token_version + 1 (every device token and every panel cookie,
 *             which is bound to it, stops working), then every device token
 *             and every device is marked revoked. The same three writes as
 *             revokeEverything in src/db.ts. Revoking the devices is also what
 *             kills a panel ticket already minted: /p/<device>/_auth refuses a
 *             device that is revoked. panel_tickets is NOT touched, see below.
 *   sessions  session_version + 1, when accounts has that column (added by
 *             migration 0017). Every browser session cookie stops working.
 *   grant     the Drive refresh token is opened (current key, then previous),
 *             revoked at Google, and only then is the stored ciphertext
 *             deleted. A grant that could not be revoked is left in place and
 *             recorded, so that a later run can retry it.
 *
 * panel_tickets holds the nonces of tickets that were SPENT, so a ticket
 * cannot be used twice. Deleting rows from it would make a spent ticket
 * usable again, the opposite of what this tool is for.
 *
 * Every step is recorded per account as it finishes. A run is identified by
 * its run id; running again with the same id skips what is recorded as done
 * and retries what failed. A new run id is a new incident and does everything
 * again.
 */

/** D1 allows 100 bound parameters in a statement; the busiest one here binds a timestamp plus the ids. */
export const MAX_BATCH = 90;
export const DEFAULT_BATCH = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// --- Opening a sealed grant, the way src/crypto.ts and src/drive-keys.ts do ---
// Kept in step with them by test/bulk-revoke.test.ts, which seals with the
// Worker's own code and opens with this, and the other way round.

const enc = new TextEncoder();

function fromB64Url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function keyId(secret) {
  return (await sha256Hex("syllabus-drive-key-id:" + secret)).slice(0, 8);
}

async function aesKey(secret) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(secret)), "AES-GCM", false, ["decrypt"]);
}

/** The plain refresh token. Read-only: unlike the Worker, this never seals the row again. Throws when neither key opens it. */
export async function unseal(keys, sealed) {
  const current = keys.DRIVE_KEY;
  const previous = keys.DRIVE_KEY_PREVIOUS || "";
  const named = sealed.split(".")[2] ?? "";
  let order;
  if (named === (await keyId(current))) order = [current];
  else if (previous && named === (await keyId(previous))) order = [previous];
  else order = previous ? [current, previous] : [current];
  let failure = null;
  for (const secret of order) {
    try {
      const [iv, box] = sealed.split(".");
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64Url(iv) }, await aesKey(secret), fromB64Url(box));
      return new TextDecoder().decode(plain);
    } catch (err) {
      failure = err;
    }
  }
  throw failure ?? new Error("the grant opens under neither key");
}

// --- Small helpers -----------------------------------------------------------

const marks = (n) => Array.from({ length: n }, () => "?").join(",");
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Text from something we did not write (a network error) made safe to print: no addresses, no long tokens, short. */
export function safe(text) {
  return String(text ?? "")
    .replace(EMAIL, "[email]")
    .replace(/[A-Za-z0-9_\-./+=]{24,}/g, "[long]")
    .slice(0, 160);
}

/** The confirmation an operator types to run for real: names the number, so a stale command cannot pass. */
export function confirmationPhrase(count) {
  return `REVOKE ${count} ACCOUNTS`;
}

/** Turn an audit log's text into the set of steps already done, keyed "account:step". Ignores lines it cannot read. */
export function parseLedger(text) {
  const done = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.event === "step" && row.ok === true && typeof row.account === "string") done.add(`${row.account}:${row.step}`);
    } catch {
      // A torn last line from a crash is not worth stopping for.
    }
  }
  return done;
}

async function hasSessionVersion(db) {
  const { rows } = await db.query("PRAGMA table_info(accounts)", []);
  return rows.some((r) => r.name === "session_version");
}

/** Every account id in scope, in batches. For --only, ids that do not exist are reported, not fatal. */
async function* scope(db, only, size, missing) {
  if (only) {
    for (const part of chunks(only, size)) {
      const { rows } = await db.query(`SELECT id FROM accounts WHERE id IN (${marks(part.length)}) ORDER BY id`, part);
      const found = new Set(rows.map((r) => r.id));
      for (const id of part) if (!found.has(id)) missing.push(id);
      if (found.size) yield [...found];
    }
    return;
  }
  let after = "";
  for (;;) {
    const { rows } = await db.query("SELECT id FROM accounts WHERE id > ? ORDER BY id LIMIT ?", [after, size]);
    if (!rows.length) return;
    after = rows[rows.length - 1].id;
    yield rows.map((r) => r.id);
  }
}

// --- Google -----------------------------------------------------------------

/**
 * Revoke one refresh token at Google and say what happened, as a code and never
 * as text. Unlike revokeGrantAtGoogle in src/drive.ts, which is best effort so a
 * person can always disconnect, this reads the answer: a 200 is done, a 400
 * invalid_token means Google no longer honors it (also done), and anything else
 * is a failure to retry. 429 and 5xx are retried here a few times first.
 */
export async function revokeAtGoogle(fetchFn, token, sleep) {
  let code = "network";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res;
    try {
      res = await fetchFn(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      code = "network";
      if (attempt < 3) await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 200) return { ok: true, result: "revoked" };
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      if (body && body.error === "invalid_token") return { ok: true, result: "already_invalid" };
      return { ok: false, result: "google_400" };
    }
    code = `google_${res.status}`;
    if (res.status !== 429 && res.status < 500) return { ok: false, result: code };
    const wait = Math.min(30, Number(res.headers.get("Retry-After")) || attempt) * 1000;
    if (attempt < 3) await sleep(wait);
  }
  return { ok: false, result: code };
}

// --- The run -----------------------------------------------------------------

/**
 * @param {object} deps
 *   db       { query(sql, params) -> Promise<{ rows, changes }> }
 *   fetch    the network, for Google only
 *   keys     { DRIVE_KEY, DRIVE_KEY_PREVIOUS }, or null when there is no key
 *   done     Set from parseLedger: steps already finished in this run
 *   append   (object) => Promise<void>: one audit line
 *   prompt   (text) => Promise<string>: what the operator types back
 *   out      (line) => void
 *   sleep    (ms) => Promise<void>
 *   now      () => number
 * @param {object} options
 *   execute, only (array of ids or null), batchSize, perSecond, skipDrive, runId
 */
export async function bulkRevoke(deps, options) {
  const { db, keys, done, out } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const execute = options.execute === true;
  const batchSize = Math.min(MAX_BATCH, Math.max(1, options.batchSize ?? DEFAULT_BATCH));
  const perSecond = Math.max(0.1, options.perSecond ?? 5);
  const skipDrive = options.skipDrive === true;
  const runId = options.runId;
  if (!RUN_ID.test(runId ?? "")) throw new Error("the run id must be 1 to 40 letters, digits, dashes or underscores");
  const only = options.only ? [...new Set(options.only)] : null;
  if (only) for (const id of only) if (!ID.test(id)) throw new Error("an --only value is not an account id");
  if (only && !only.length) throw new Error("--only named no accounts");
  if (!skipDrive && !keys?.DRIVE_KEY) throw new Error("DRIVE_KEY is not in the environment; set it, or pass --skip-drive to leave Drive grants alone");

  const sessions = await hasSessionVersion(db);
  const missing = [];
  const totals = { accounts: 0, pendingTokens: 0, pendingSessions: 0, pendingGrants: 0, activeDevices: 0, liveTokens: 0, grants: 0, readable: 0, unreadable: 0 };
  const ids = [];

  // Pass one, reads only: what is in scope and what a run would do.
  for await (const batch of scope(db, only, batchSize, missing)) {
    totals.accounts += batch.length;
    ids.push(...batch);
    const todo = (step) => batch.filter((id) => !done.has(`${id}:${step}`));
    totals.pendingTokens += todo("tokens").length;
    if (sessions) totals.pendingSessions += todo("sessions").length;
    const g = todo("grant");
    totals.pendingGrants += skipDrive ? 0 : g.length;
    const dev = await db.query(`SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND account_id IN (${marks(batch.length)})`, batch);
    totals.activeDevices += Number(dev.rows[0]?.n ?? 0);
    const tok = await db.query(
      `SELECT COUNT(*) AS n FROM device_tokens WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE account_id IN (${marks(batch.length)}))`,
      batch,
    );
    totals.liveTokens += Number(tok.rows[0]?.n ?? 0);
    if (!skipDrive && g.length) {
      const grants = await db.query(`SELECT refresh_token_enc FROM drive_grants WHERE account_id IN (${marks(g.length)})`, g);
      totals.grants += grants.rows.length;
      for (const row of grants.rows) {
        try {
          await unseal(keys, row.refresh_token_enc);
          totals.readable += 1;
        } catch {
          totals.unreadable += 1;
        }
      }
    }
  }

  out(`Run id: ${runId}`);
  out(`Scope: ${only ? `${only.length} named account(s)` : "every account"}; ${totals.accounts} found`);
  if (missing.length) out(`Not found (ignored): ${missing.join(", ")}`);
  out(`Still to do in this run: device tokens and panel cookies ${totals.pendingTokens}, browser sessions ${sessions ? totals.pendingSessions : "not possible (see below)"}, Drive grants ${skipDrive ? "skipped by request" : totals.pendingGrants}`);
  out(`Now live: ${totals.activeDevices} device(s), ${totals.liveTokens} device token(s)`);
  if (!skipDrive) out(`Drive grants to revoke: ${totals.grants} (${totals.readable} open with the keys given, ${totals.unreadable} do not)`);
  if (!sessions) {
    out("WARNING: accounts has no session_version column (migration 0017, PR #52), so browser sessions are NOT invalidated by this run.");
    out("         Run again with the same run id after 0017 is deployed, or rotate SESSION_SECRET, which signs everyone out.");
  }
  if (skipDrive) out("WARNING: --skip-drive, so Drive grants stay valid at Google and stored.");

  const result = {
    runId, executed: false, sessionsSupported: sessions, totals: { ...totals }, missing,
    tokensDone: 0, devicesRevoked: 0, deviceTokensRevoked: 0, sessionsBumped: 0, sessionsSkipped: 0,
    grants: { revoked: 0, already_invalid: 0, none: 0, failed: 0, unreadable: 0 }, failures: [], aborted: false,
  };

  if (!execute) {
    out("Dry run: nothing was changed. Add --execute to do this.");
    return result;
  }
  if (totals.accounts === 0) {
    out("Nothing in scope.");
    return result;
  }

  const phrase = confirmationPhrase(totals.accounts);
  const typed = (await deps.prompt(`This ends every device token, panel cookie${sessions ? ", browser session" : ""} and Drive grant of ${totals.accounts} account(s), and cannot be undone.\nType exactly "${phrase}" to continue: `)).trim();
  if (typed !== phrase) {
    out("Confirmation did not match. Nothing was changed.");
    result.aborted = true;
    return result;
  }

  result.executed = true;
  const stamp = () => new Date(now()).toISOString();
  await deps.append({ event: "run_start", run: runId, at: stamp(), scope: only ? "only" : "all", accounts: totals.accounts, sessions_supported: sessions, skip_drive: skipDrive });
  const record = async (account, step, ok, code) => {
    await deps.append({ event: "step", run: runId, at: stamp(), account, step, ok, ...(code ? { code } : {}) });
    if (ok) done.add(`${account}:${step}`);
  };

  const minGap = 1000 / perSecond;
  let lastCall = 0;

  let processed = 0;
  for (const batch of chunks(ids, batchSize)) {
    const t = batch.filter((id) => !done.has(`${id}:tokens`));
    if (t.length) {
      const ts = stamp();
      await db.query(`UPDATE accounts SET token_version = token_version + 1 WHERE id IN (${marks(t.length)})`, t);
      const tokens = await db.query(
        `UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND device_id IN (SELECT id FROM devices WHERE account_id IN (${marks(t.length)}))`,
        [ts, ...t],
      );
      const devices = await db.query(`UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND account_id IN (${marks(t.length)})`, [ts, ...t]);
      result.deviceTokensRevoked += tokens.changes;
      result.devicesRevoked += devices.changes;
      for (const id of t) await record(id, "tokens", true);
      result.tokensDone += t.length;
    }

    const s = batch.filter((id) => !done.has(`${id}:sessions`));
    if (sessions && s.length) {
      await db.query(`UPDATE accounts SET session_version = session_version + 1 WHERE id IN (${marks(s.length)})`, s);
      for (const id of s) await record(id, "sessions", true);
      result.sessionsBumped += s.length;
    } else if (!sessions) result.sessionsSkipped += s.length;

    const g = skipDrive ? [] : batch.filter((id) => !done.has(`${id}:grant`));
    if (g.length) {
      const { rows } = await db.query(`SELECT account_id, refresh_token_enc FROM drive_grants WHERE account_id IN (${marks(g.length)})`, g);
      const have = new Map(rows.map((r) => [r.account_id, r.refresh_token_enc]));
      for (const id of g) {
        if (!have.has(id)) {
          await record(id, "grant", true, "none");
          result.grants.none += 1;
          continue;
        }
        const sealed = have.get(id);
        let token;
        try {
          token = await unseal(keys, sealed);
        } catch {
          await record(id, "grant", false, "unreadable");
          result.grants.unreadable += 1;
          result.failures.push({ account: id, code: "unreadable" });
          continue;
        }
        const wait = lastCall + minGap - now();
        if (wait > 0) await sleep(wait);
        const outcome = await revokeAtGoogle(deps.fetch, token, sleep);
        lastCall = now();
        token = "";
        if (!outcome.ok) {
          await record(id, "grant", false, outcome.result);
          result.grants.failed += 1;
          result.failures.push({ account: id, code: outcome.result });
          continue;
        }
        // Only the row that was read: a grant made since, by a person reconnecting, is a new consent.
        await db.query("DELETE FROM drive_grants WHERE account_id = ? AND refresh_token_enc = ?", [id, sealed]);
        await record(id, "grant", true, outcome.result);
        result.grants[outcome.result] += 1;
      }
    }
    processed += batch.length;
    out(`... ${processed} of ${ids.length} accounts`);
  }

  await deps.append({ event: "run_end", run: runId, at: stamp(), failures: result.failures.length });
  out("");
  out(`Done. Device tokens and panel cookies: ${result.tokensDone} account(s); ${result.devicesRevoked} device(s) and ${result.deviceTokensRevoked} device token(s) marked revoked.`);
  out(sessions ? `Browser sessions: ${result.sessionsBumped} account(s) signed out.` : "Browser sessions: NOT done (no session_version column).");
  if (!skipDrive) {
    const g = result.grants;
    out(`Drive grants: ${g.revoked} revoked at Google, ${g.already_invalid} already dead at Google, ${g.none} account(s) had none, ${g.failed + g.unreadable} failed.`);
  }
  if (result.failures.length) {
    out(`FAILED (${result.failures.length}); their grants are still stored. Run again with --run-id ${runId} to retry:`);
    for (const f of result.failures.slice(0, 25)) out(`  ${f.account}  ${f.code}`);
    if (result.failures.length > 25) out(`  ... and ${result.failures.length - 25} more, all in the audit log`);
  }
  return result;
}
