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
 * limits in proxy.ts. /device/poll in particular answers `slow_down`, never
 * 429, because RFC 8628 says so and the panel abandons a claim on anything
 * else.
 */

import type { Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { page } from "./pages";

/** A limit: at most `limit` requests per `window` seconds, per key. */
export type Limit = { limit: number; window: number };

export const LIMITS = {
  /** GET /login, per source. Sets a cookie and redirects; a person does this a few times a day. */
  login: { limit: 60, window: 600 },
  /** GET /oauth2/callback, per source. Each one can cost a call to Google's token endpoint. */
  callback: { limit: 60, window: 600 },
  /** GET /device?code=, per account. Looking a code up is how a guesser would learn one is live. */
  deviceLookup: { limit: 60, window: 600 },
  /**
   * POST /device/approve, per account and per source. A guessed code would
   * enroll somebody else's Mac into the guesser's account, so this is the
   * limit that makes guessing hopeless rather than merely unlikely.
   */
  deviceApprove: { limit: 30, window: 600 },
  /**
   * POST /stripe/webhook, per source, checked before the signature. Stripe
   * delivers from a handful of addresses and retries anything refused, so
   * this is lenient on purpose: it exists so that garbage cannot make this
   * service HMAC an unbounded stream of bodies, not to shape Stripe.
   */
  stripeWebhook: { limit: 300, window: 60 },
  /** The three /billing routes, per account. Each one calls Stripe's API. */
  billing: { limit: 20, window: 600 },
} as const satisfies Record<string, Limit>;

/** Who is asking, as well as the edge can say. "unknown" outside Cloudflare. */
export function clientAddress(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") || "unknown";
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
