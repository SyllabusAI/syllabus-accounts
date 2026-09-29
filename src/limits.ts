/**
 * Rate limits for the routes that answer before anybody has proved much.
 *
 * Every limit here is a fixed window in D1 (db.hitRateLimit), keyed by
 * either the source address or the account. The source address is what
 * Cloudflare's edge says it is (CF-Connecting-IP, which a client cannot set:
 * the edge overwrites it). It is a weak identifier: a campus shares one
 * address across many students, so every per-address limit here is set far
 * above what a whole lecture hall signing in at once would reach, and only
 * bites on a script.
 *
 * The limits that already existed before this file stay where they were:
 * /device/start and /device/poll in devices.ts, and the per-account proxy
 * limits in proxy.ts and assistant.ts. docs/rate-limits.md lists every route
 * and which limit covers it; add a route there when you add one here. /device/poll in particular answers `slow_down`, never
 * 429, because RFC 8628 says so and the panel abandons a claim on anything
 * else.
 */

import type { Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { page } from "./pages";

/** A limit: at most `limit` requests per `window` seconds, per key. */
export type Limit = { limit: number; window: number };

/**
 * Why the per-ADDRESS limits are ten times the per-account ones.
 *
 * Campus Wi-Fi puts a whole lecture hall behind one public address (NAT, or
 * carrier-grade NAT on a phone network). Two hundred students signing in at
 * the start of a class is several hundred /login and /oauth2/callback hits
 * from one address in a few minutes, and a sign-in that fails for everybody
 * in the room is the worst outcome this file could produce. So an address
 * limit is sized for a crowd and only stops a script; the per-account limits
 * are what hold a single person to human rates.
 */
export const LIMITS = {
  /** GET /login, per source. Sized for a lecture hall behind one NAT address. */
  login: { limit: 600, window: 600 },
  /** GET /oauth2/callback, per source. Each one can cost a call to Google's token endpoint. */
  callback: { limit: 600, window: 600 },
  /** GET /device?code=, per account. Looking a code up is how a guesser would learn one is live. */
  deviceLookup: { limit: 60, window: 600 },
  /**
   * GET /device?code=, per source: the same guard for a pile of accounts on
   * one address, as deviceApproveAddress is for approving. Sized for a class
   * opening the link their Macs showed them, a few loads each.
   */
  deviceLookupAddress: { limit: 600, window: 600 },
  /**
   * POST /device/approve, per account. A guessed code would enroll somebody
   * else's Mac into the guesser's account, so this is the limit that makes
   * guessing hopeless rather than merely unlikely.
   */
  deviceApprove: { limit: 30, window: 600 },
  /**
   * POST /device/approve, per source: the same guard for a pile of accounts
   * on one address, sized for a class connecting their Macs together.
   */
  deviceApproveAddress: { limit: 300, window: 600 },
  /**
   * POST /device/start, per source. Every Mac in a lecture hall shares one
   * NAT address or one /64, and each starts a claim when it signs in (and
   * again if a code expires first), so this is sized for a class pairing
   * together. PENDING_CAP in devices.ts is the backstop that does not depend
   * on the key.
   */
  deviceStart: { limit: 600, window: 600 },
  /**
   * POST /device/poll, per source. A pairing Mac polls every POLL_INTERVAL
   * (5 s), twelve a minute, so this is a hundred Macs pairing at once. Past
   * it the answer is slow_down, which a panel waits on, never a refusal.
   */
  devicePoll: { limit: 1200, window: 60 },
  /**
   * POST /stripe/webhook, per source, checked before the signature. Stripe
   * delivers from a handful of addresses and retries anything refused, so
   * this is lenient on purpose: it exists so that garbage cannot make this
   * service HMAC an unbounded stream of bodies, not to shape Stripe.
   */
  stripeWebhook: { limit: 300, window: 60 },
  /** The three /billing routes, per account. Each one calls Stripe's API. */
  billing: { limit: 20, window: 600 },
  /**
   * A bearer that names no live device token, per source. Only FAILURES count,
   * so a real panel is never near it; it stops a script from making the
   * service do a database lookup per guess. Sized for a lecture hall of Macs
   * whose tokens were all revoked at once ("sign out every Mac"), each
   * retrying a few times before it gives up.
   */
  badToken: { limit: 600, window: 600 },
  /**
   * Every request carrying a device token, per device, whatever the route.
   * The floor under the specific limits below and the per-account proxy
   * limits: a panel does a handful of calls a minute, so this only stops a
   * stolen token or a stuck loop from hammering D1.
   */
  deviceRequests: { limit: 600, window: 60 },
  /**
   * Every request carrying a session cookie, per account, on routes other
   * than the relayed panel (relayView has its own). A person clicking around
   * their account page is a few requests a minute.
   */
  sessionRequests: { limit: 1200, window: 600 },
  /**
   * GET /relay/connect, per device. Opening the panel's socket wakes a
   * Durable Object; a panel reconnects with backoff after a drop, so a
   * device that connects this often is looping.
   */
  relayConnect: { limit: 120, window: 600 },
  /**
   * Requests relayed to a panel (/p/<device>/...), per account, on both hosts
   * (one bucket). Each one crosses a WebSocket to somebody's Mac, and a panel
   * page polls, so this is generous: two requests a second sustained.
   */
  relayView: { limit: 1200, window: 600 },
  /** POST /drive/token, per account. Each one is a call to Google; a panel caches the token for an hour. */
  driveToken: { limit: 60, window: 600 },
  /** PUT /settings/:name, per account. A database write per call. */
  settingsWrite: { limit: 120, window: 600 },
  /** POST /account/delete, per account. Each attempt calls Stripe before it touches a row. */
  accountDelete: { limit: 5, window: 600 },
  /**
   * GET /p/<device>/_auth on the panel host (the ticket exchange), per
   * source. Reached with a link the account host just minted, so a real
   * person hits it once per panel opening; sized for a class.
   */
  panelTicket: { limit: 600, window: 600 },
} as const satisfies Record<string, Limit>;

/**
 * Who is asking, as well as the edge can say. "unknown" outside Cloudflare.
 *
 * An IPv6 address is cut to its /64. One home or one phone is handed a whole
 * /64 (2^64 addresses) and can pick a fresh one per request, so keyed on the
 * full address every per-address limit here was a limit only for IPv4. The
 * /64 is the unit a network actually hands out, which makes it the IPv6
 * equivalent of one NAT address, and the limits are already sized for that.
 */
export function clientAddress(c: Context<AppEnv>): string {
  const raw = (c.req.header("CF-Connecting-IP") ?? "").trim();
  if (!raw) return "unknown";
  return raw.includes(":") ? ipv6Bucket(raw) : raw;
}

/**
 * The /64 an IPv6 address sits in, as "a:b:c:d::/64" with each group in its
 * shortest lowercase form, so every spelling of one network is one key. An
 * IPv4-mapped address (::ffff:192.0.2.1) is its IPv4 address. Anything that
 * does not parse is returned as it came, which is no worse than before.
 */
export function ipv6Bucket(address: string): string {
  const text = address.split("%")[0].toLowerCase();
  const halves = text.split("::");
  if (halves.length > 2) return address;
  const groups = (part: string) => (part ? part.split(":") : []);
  let head = groups(halves[0]);
  let tail = halves.length === 2 ? groups(halves[1]) : [];
  // A dotted IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const last = (tail.length ? tail : head).at(-1) ?? "";
  let v4 = "";
  if (last.includes(".")) {
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(last) || last.split(".").some((n) => Number(n) > 255)) return address;
    v4 = last;
    const [a, b, c2, d] = last.split(".").map(Number);
    const pair = [((a << 8) | b).toString(16), ((c2 << 8) | d).toString(16)];
    if (tail.length) tail = [...tail.slice(0, -1), ...pair];
    else head = [...head.slice(0, -1), ...pair];
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return address;
  const all = [...head, ...Array(missing).fill("0"), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address;
  const n = all.map((g) => parseInt(g, 16));
  if (v4 && n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) return v4;
  return n.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

/**
 * Counts this request against `bucket` and says whether it is over.
 *
 * Returns the Retry-After seconds when refused, or null to carry on.
 */
export async function overLimit(c: Context<AppEnv>, bucket: string, rule: Limit): Promise<number | null> {
  const gate = await db.hitRateLimit(c.env.DB, bucket, rule.limit, rule.window);
  return gate.allowed ? null : gate.retryAfter;
}

/** The JSON refusal, for routes a program calls. */
export function limitedJson(c: Context<AppEnv>, rule: Limit, retryAfter: number) {
  return c.json({ error: "rate_limited", limit: rule.limit, window_seconds: rule.window }, 429, {
    "Retry-After": String(retryAfter),
  });
}

/** The page refusal, for routes a person reaches in a browser. */
export function limitedPage(c: Context<AppEnv>, retryAfter: number) {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return c.html(
    page("Slow down", `<p>Too many tries from here in a short time. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.</p>`),
    429,
    { "Retry-After": String(retryAfter) },
  );
}
