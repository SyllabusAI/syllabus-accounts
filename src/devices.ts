/**
 * Claiming a panel: the device-code flow (RFC 8628, trimmed to what we need).
 *
 *   POST /device/start    the panel asks for a code; gets device_code + user_code
 *   GET  /device?code=    the person, signed in, sees the code and confirms
 *   POST /device/approve  ties the code to their account, creates the device
 *   POST /device/poll     the panel, polling with device_code, receives its token
 *
 * The panel never sees a browser cookie and the browser never sees the
 * device token: the code is the only thing that crosses between them, and it
 * is typed by a person. The token is minted at collection time, so it exists
 * in plain form only in the one response that carries it.
 */

import { Hono, type Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { clientAddress as source, LIMITS, limitedPage, overLimit } from "./limits";
import { approvedPage, devicePage } from "./pages";
import { browserOnly, sameOrigin, sessionSignedInAt, setSession } from "./session";
import { newDeviceToken, newUserCode, normalizeUserCode, plusSeconds, randomId, sha256Hex } from "./util";
import { log } from "./log";

// Ten minutes: ASVS 2.7.2's ceiling for an out-of-band code (F-17). The Mac
// reads `expires_in` and shows what is left, so nothing there assumes 15.
export const CODE_SECONDS = 600;
export const POLL_INTERVAL = 5;
const PROFILES = new Set(["syllabus", "sous"]);

/**
 * How long a device token lives without being used.
 *
 * The window slides: every use moves it forward, so a Mac that runs Syllabus
 * at least once a quarter is never signed out, while a token on a Mac that
 * was lost, sold or wiped dies on its own instead of waiting for its owner to
 * remember it. Sliding is recorded at most once per TOKEN_TOUCH_SECONDS, so
 * a panel polling all day costs one D1 write a day, not one per request; the
 * cost is that the window can end up to a day earlier than the last request.
 */
export const TOKEN_IDLE_DAYS = 90;
export const TOKEN_TOUCH_SECONDS = 24 * 60 * 60;

/**
 * What to do with a token that otherwise checks out, given when it was last
 * stamped as used. A null stamp is a token minted before stamping existed
 * (or in the minute between the migration and the deploy); it counts as used
 * just now, so nobody is signed out by the change, and gets stamped.
 */
export function tokenStanding(lastUsedAt: string | null, nowMs = Date.now()): "live" | "touch" | "expired" {
  if (lastUsedAt === null) return "touch";
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return "touch";
  const idle = nowMs - last;
  if (idle > TOKEN_IDLE_DAYS * 86_400_000) return "expired";
  return idle >= TOKEN_TOUCH_SECONDS * 1000 ? "touch" : "live";
}

/**
 * What the two open routes allow, and why they need anything at all.
 *
 * /device/start and /device/poll are the only routes here that answer before
 * anybody has proved who they are; the per-account limits protecting the rest
 * of the service have nothing to key on. Unlimited, /device/start is a free
 * way to make this service write a database row per request and to churn the
 * user-code space that people read off a screen.
 *
 * A real panel starts one claim per sign-in and polls it every POLL_INTERVAL
 * seconds until a person types the code, so the limits below are far above
 * anything a Mac does and only bite on a script. They are keyed by source
 * address (LIMITS.deviceStart and LIMITS.devicePoll in limits.ts, sized for
 * a lecture hall on one address), which is a weak identifier that costs an
 * attacker something to vary; PENDING_CAP is the backstop that does not
 * depend on the key at all.
 */
const PENDING_CAP = 500;

function rateLimited(c: Context<AppEnv>, limit: number, windowSeconds: number, retryAfter: number) {
  return c.json({ error: "rate_limited", limit, window_seconds: windowSeconds }, 429, {
    "Retry-After": String(retryAfter),
  });
}

export const devices = new Hono<AppEnv>();

function tidyName(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 80);
}

/**
 * Recognizing a Mac that signs in again.
 *
 * A Mac that lost its token (its data folder removed, the app reinstalled
 * onto a clean home) and signed in again used to become a second device, the
 * first left "Not connected" on the account page until it idled out. The app
 * now sends `machine` with /device/start: an opaque id it derives on the Mac
 * (intake/account.py machine_id), never shown to a browser and never logged.
 *
 * Nothing stores it as sent. The pending claim keeps machineHash(machine),
 * which goes with the claim; the device keeps machineKey(), which binds that
 * hash to the account and profile, so the stored value means nothing outside
 * the one account and two accounts signed in on one Mac hold unrelated keys.
 *
 * When the new device's token is collected, the account's other live devices
 * with the same key are revoked like a removal from the account page. It is
 * done at collection, not approval, so the old entry goes only once the Mac
 * that asked actually holds its replacement token, and only within the
 * account that approved: an id cannot reach another account's devices, and
 * the approval itself is the same person-typed code as before. An app that
 * sends no id (anything before this) gets no key and today's behavior.
 */
const MACHINE_ID = /^[A-Za-z0-9_-]{16,128}$/;

export async function machineHash(raw: unknown): Promise<string | null> {
  const value = String(raw ?? "");
  return MACHINE_ID.test(value) ? sha256Hex(`syllabus-machine:${value}`) : null;
}

export async function machineKey(accountId: string, profile: string, hash: string | null): Promise<string | null> {
  return hash ? sha256Hex(`syllabus-device:${accountId}:${profile}:${hash}`) : null;
}

devices.post("/device/start", async (c) => {
  const gate = await db.hitRateLimit(c.env.DB, `device-start:${source(c)}`, LIMITS.deviceStart.limit, LIMITS.deviceStart.window);
  if (!gate.allowed) return rateLimited(c, LIMITS.deviceStart.limit, LIMITS.deviceStart.window, gate.retryAfter);

  const body = (await c.req.json().catch(() => ({}))) as { profile?: string; name?: string; machine?: string };
  const profile = PROFILES.has(String(body.profile)) ? String(body.profile) : "syllabus";
  const name = tidyName(body.name);
  const machine = await machineHash(body.machine);
  await db.sweepDeviceCodes(c.env.DB);
  // Expired windows are of no further use and this is the quietest route
  // that runs often enough to clear them.
  await db.sweepRateLimits(c.env.DB, Math.floor(Date.now() / 1000) - 3 * LIMITS.deviceStart.window);

  // The limit above is per source; this one is not, so a spread-out flood
  // still cannot fill the table or exhaust the codes people have to read.
  if ((await db.pendingDeviceCodes(c.env.DB)) >= PENDING_CAP) {
    log(`device/start refused: ${PENDING_CAP} claims already pending`);
    return c.json({ error: "too_many_pending" }, 503, { "Retry-After": String(CODE_SECONDS) });
  }

  const deviceCode = randomId(32);
  let userCode = newUserCode();
  // A collision on a 32^8 space is unlikely; the unique index makes it impossible.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await db.deviceCodeByUserCode(c.env.DB, userCode))) break;
    userCode = newUserCode();
  }
  await db.insertDeviceCode(c.env.DB, await sha256Hex(deviceCode), userCode, profile, name, plusSeconds(CODE_SECONDS), machine);
  const verify = `${c.env.PUBLIC_URL}/device`;
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verify,
    verification_uri_complete: `${verify}?code=${encodeURIComponent(userCode)}`,
    expires_in: CODE_SECONDS,
    interval: POLL_INTERVAL,
  });
});

devices.get("/device", async (c) => {
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=" + encodeURIComponent(c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : "")));
  const code = normalizeUserCode(c.req.query("code") ?? "");
  // A signed-in guesser learns from this page whether a code is live, so it
  // is limited like the approval it leads to: per account, and per address
  // so that a pile of accounts on one address gains nothing.
  if (code) {
    for (const [bucket, rule] of [
      [`device-lookup:${account.id}`, LIMITS.deviceLookup],
      [`device-lookup-ip:${source(c)}`, LIMITS.deviceLookupAddress],
    ] as const) {
      const wait = await overLimit(c, bucket, rule);
      if (wait !== null) return limitedPage(c, wait);
    }
  }
  let deviceName = "";
  let askedAt = "";
  if (code) {
    const pending = await db.deviceCodeByUserCode(c.env.DB, code);
    if (pending && pending.expires_at > new Date().toISOString() && !pending.approved_account_id) {
      deviceName = pending.device_name;
      askedAt = pending.created_at;
    }
  }
  return c.html(devicePage(account, code, deviceName, "", askedAt));
});

devices.post("/device/approve", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login?next=/device");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  // A code guessed right would enroll somebody else's Mac into this account,
  // and its notes into this account's Drive. 32^8 codes against at most
  // PENDING_CAP live ones is already long odds; these make it hopeless, per
  // account and per address, so a pile of accounts on one address gains nothing.
  for (const [bucket, rule] of [
    [`device-approve:${account.id}`, LIMITS.deviceApprove],
    [`device-approve-ip:${source(c)}`, LIMITS.deviceApproveAddress],
  ] as const) {
    const wait = await overLimit(c, bucket, rule);
    if (wait !== null) return limitedPage(c, wait);
  }
  const form = await c.req.parseBody();
  const typed = String(form.user_code ?? "");
  const code = normalizeUserCode(typed);
  if (!code) return c.html(devicePage(account, typed, "", "A code is four letters, a dash, and four more."), 400);

  const pending = await db.deviceCodeByUserCode(c.env.DB, code);
  if (!pending || pending.expires_at < new Date().toISOString()) {
    return c.html(devicePage(account, code, "", "That code is not waiting to be connected. Ask Syllabus for a new one."), 400);
  }
  if (pending.approved_account_id) {
    return c.html(devicePage(account, code, "", "That code was already used."), 400);
  }
  const name = pending.device_name || "A Mac";
  const key = await machineKey(account.id, pending.profile, pending.machine_hash);
  const device = await db.createDevice(c.env.DB, account.id, name, pending.profile, key);
  const ok = await db.approveDeviceCode(c.env.DB, pending.device_code_hash, account.id, device.id);
  if (!ok) {
    await db.revokeDevice(c.env.DB, account.id, device.id);
    return c.html(devicePage(account, code, "", "That code was already used."), 400);
  }
  log(`device ${device.id} joined account ${account.id}`);
  return c.html(approvedPage(account, name));
});

devices.post("/device/poll", async (c) => {
  // slow_down rather than our own refusal: it is what RFC 8628 says a token
  // endpoint answers a client polling too fast, and a panel already handles
  // it by waiting longer (run_claim in intake/account.py). Anything else
  // reads to that loop as a refusal and abandons a claim that is still good,
  // which would turn a shared address into a sign-in that cannot finish.
  const gate = await db.hitRateLimit(c.env.DB, `device-poll:${source(c)}`, LIMITS.devicePoll.limit, LIMITS.devicePoll.window);
  if (!gate.allowed) {
    return c.json({ error: "slow_down", interval: POLL_INTERVAL * 2 }, 400, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  const body = (await c.req.json().catch(() => ({}))) as { device_code?: string };
  const deviceCode = String(body.device_code ?? "");
  if (!deviceCode) return c.json({ error: "invalid_request" }, 400);
  const pending = await db.deviceCodeByHash(c.env.DB, await sha256Hex(deviceCode));
  if (!pending) return c.json({ error: "invalid_grant" }, 400);
  if (pending.expires_at < new Date().toISOString()) return c.json({ error: "expired_token" }, 400);
  if (!pending.approved_account_id || !pending.approved_device_id) {
    return c.json({ error: "authorization_pending", interval: POLL_INTERVAL }, 400);
  }
  if (!(await db.collectDeviceCode(c.env.DB, pending.device_code_hash))) {
    return c.json({ error: "invalid_grant" }, 400);
  }
  const account = await db.accountById(c.env.DB, pending.approved_account_id);
  if (!account) return c.json({ error: "invalid_grant" }, 400);
  const token = newDeviceToken();
  await db.insertDeviceToken(c.env.DB, await sha256Hex(token), pending.approved_device_id, account.token_version);
  // The token is on its way to the Mac, so its earlier entries can go (see
  // machineKey above). Scoped to the approving account.
  for (const old of await db.sameMachineDevices(c.env.DB, account.id, pending.approved_device_id)) {
    if (await db.revokeDevice(c.env.DB, account.id, old)) {
      log(`device ${old} replaced by ${pending.approved_device_id} on account ${account.id}`);
    }
  }
  return c.json({
    token,
    account: { id: account.id, email: account.email, name: account.name },
    device: { id: pending.approved_device_id, name: pending.device_name || "A Mac", profile: pending.profile },
  });
});

/** From the account page: remove a Mac. Its token stops working at once. */
devices.post("/devices/:id/revoke", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  await db.revokeDevice(c.env.DB, account.id, c.req.param("id"));
  return c.redirect("/");
});

/**
 * From the account page ("Sign out everywhere"): remove every Mac, orphan
 * every token, and sign out every other browser at once.
 *
 * What to reach for when a token may be in somebody else's hands and the list
 * of Macs can no longer be trusted to be the list you enrolled.
 */
devices.post("/devices/revoke-all", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const account = c.get("account");
  if (!account) return c.redirect("/login");
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  const signedInAt = await sessionSignedInAt(c); // before the bump, which makes this cookie stale
  const { removed, sessionVersion } = await db.revokeEverything(c.env.DB, account.id);
  // Every browser is signed out too, this one included unless it is handed a
  // cookie under the new version. It keeps its original sign-in time, so this
  // does not count as the recent sign-in that deleting an account asks for.
  await setSession(c, { id: account.id, session_version: sessionVersion }, signedInAt || Date.now());
  log(`account ${account.id} signed out every Mac (${removed})`);
  return c.redirect("/");
});
