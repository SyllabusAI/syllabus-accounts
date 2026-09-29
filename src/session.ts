/**
 * The browser session: a signed cookie naming the account, good for 30 days.
 *
 * The cookie holds the account id, when it was issued, and the account's
 * session_version at that moment, signed with SESSION_SECRET. It is
 * host-only: no Domain attribute, ever, so it is sent to PUBLIC_URL's host and
 * to no other, including a panel host on a subdomain (panel-host.ts).
 *
 * Nothing is stored per session. Instead every request compares the cookie's
 * version with the account row it loads anyway (sessionMiddleware), so
 * bumping the account's session_version signs out every browser at once with
 * no extra query. "Sign out every Mac" does that (revokeEverything in db.ts).
 * A cookie from before versions existed has no "v" and counts as 0.
 */

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { accountById } from "./db";
import type { AppEnv } from "./env";
import { log } from "./log";
import { countCookie, panelOrigin } from "./panel-host";

/**
 * Cookie names. Over https the session and sign-in flow cookies carry the
 * __Host- prefix, which a browser honors only for a cookie that is Secure,
 * Path=/ and has no Domain attribute, and refuses to let any other host set
 * (a Domain cookie planted from a sibling subdomain cannot use the name).
 * Over http (wrangler dev on localhost) the prefix cannot be used, so the
 * name falls back to one of its own; production is always https.
 */
export const SESSION_COOKIE = "__Host-syllabus_accounts_session";
export const FLOW_COOKIE = "__Host-syllabus_accounts_signin";
/** The names before the prefix. Never read; expired whenever a browser still sends one. */
export const LEGACY_COOKIES = ["syllabus_accounts_session", "syllabus_accounts_signin"];

export function cookieSecure(env: { PUBLIC_URL: string }): boolean {
  return env.PUBLIC_URL.startsWith("https://");
}

/** The name to use for one of the __Host- cookies above under this PUBLIC_URL. */
export function hostCookieName(env: { PUBLIC_URL: string }, name: string): string {
  return cookieSecure(env) ? name : name.replace("__Host-", "") + "_dev";
}
export const SESSION_DAYS = 30;

type SessionData = { a: string; t: number; v?: number };

/**
 * SESSION_SECRET, or a refusal to go on without one.
 *
 * An unset or empty secret would sign every cookie with a key anybody can
 * reproduce, so a missing secret is an error rather than a default. The
 * sign-in cookie between /login and the callback is signed with the same
 * secret; the two cannot be swapped for each other, because neither one's
 * contents pass the other's checks.
 */
export function sessionSecret(c: Context<AppEnv>): string {
  const secret = c.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set; refusing to sign or read a session");
  return secret;
}

/**
 * Sign the browser in as `account`. `issuedAt` is for re-issuing a cookie
 * under a new version without giving it a fresh sign-in time: signedInAt
 * proves a person was at Google's chooser, and only a sign-in may renew that.
 */
export async function setSession(
  c: Context<AppEnv>,
  account: { id: string; session_version: number },
  issuedAt: number = Date.now(),
): Promise<void> {
  const data: SessionData = { a: account.id, t: issuedAt, v: account.session_version ?? 0 };
  await setSignedCookie(c, hostCookieName(c.env, SESSION_COOKIE), JSON.stringify(data), sessionSecret(c), {
    path: "/",
    httpOnly: true,
    secure: cookieSecure(c.env),
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSession(c: Context<AppEnv>): void {
  clearHostCookie(c, SESSION_COOKIE);
}

/** Expire one of the __Host- cookies. The prefix needs Secure and Path=/ on the expiry too. */
export function clearHostCookie(c: Context<AppEnv>, name: string): void {
  deleteCookie(c, hostCookieName(c.env, name), { path: "/", secure: cookieSecure(c.env) });
}

/** A valid, unexpired session cookie's contents, or null. */
async function readSession(c: Context<AppEnv>): Promise<SessionData | null> {
  if (!c.env.SESSION_SECRET) {
    log("SESSION_SECRET is not set; every session reads as signed out");
    return null;
  }
  // setSession() writes one host-only cookie, and a browser holding it sends
  // it once. A second one of the same name was set by some other host of
  // this site with a Domain attribute (a panel host that is a sibling
  // subdomain, say, running the panel's own scripts), and which of the two a
  // parser picks is not ours to decide. Neither is trusted.
  const name = hostCookieName(c.env, SESSION_COOKIE);
  if (countCookie(c.req.header("Cookie") ?? "", name) > 1) return null;
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, name);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SessionData;
    if (typeof data.a !== "string" || typeof data.t !== "number") return null;
    if (data.v !== undefined && !(Number.isInteger(data.v) && data.v >= 0)) return null;
    if (Date.now() - data.t > SESSION_DAYS * 86400 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

/** Whether a cookie's contents still stand for this account: same id, and not issued before a bump. */
function currentFor(data: SessionData, account: { id: string; session_version: number }): boolean {
  return data.a === account.id && (data.v ?? 0) === (account.session_version ?? 0);
}

/**
 * When the browser last signed in with Google, in ms since the epoch, or 0.
 *
 * The cookie is only ever written by the sign-in callback, and every sign-in
 * goes through Google's account chooser (prompt=select_account in
 * google.ts), which a person has to click. So a recent value means a person
 * was at Google a moment ago, which no script on this origin can arrange.
 *
 * 0 too when the cookie is not the one sessionMiddleware accepted for the
 * signed-in account (an old version, or no account), so a caller never has to
 * remember to check both.
 */
export async function sessionSignedInAt(c: Context<AppEnv>): Promise<number> {
  const account = c.get("account");
  const data = await readSession(c);
  return data && account && c.get("authKind") === "session" && currentFor(data, account) ? data.t : 0;
}

/**
 * The cookies from before the __Host- prefix authenticate nothing. A browser
 * that still sends one is told to drop it on this response, so the one-time
 * sign-out costs a sign-in and nothing loops. Sent whether or not a new
 * cookie is present: a request carrying both uses the new one alone.
 */
function expireLegacyCookies(c: Context<AppEnv>): void {
  const header = c.req.header("Cookie") ?? "";
  for (const old of LEGACY_COOKIES) {
    if (countCookie(header, old) > 0) deleteCookie(c, old, { path: "/" });
  }
}

/** Sets c.var.account from the session cookie; never refuses on its own. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  expireLegacyCookies(c);
  if (c.get("account") === undefined) c.set("account", null);
  if (c.get("device") === undefined) c.set("device", null);
  const data = await readSession(c);
  if (data) {
    const account = await accountById(c.env.DB, data.a);
    // The account row is loaded anyway; its session_version is the whole
    // cost of being able to revoke a cookie.
    if (account && currentFor(data, account)) {
      c.set("account", account);
      c.set("authKind", "session");
    }
  }
  await next();
};

/**
 * For browser form posts: the request must come from our own origin.
 *
 * This says where a browser thinks it is, and nothing about who is asking. A
 * script sets Origin to whatever it likes, so this is a second lock on a door
 * that browserOnly() has to be the first lock on.
 */
export function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header("Origin") ?? "";
  const referer = c.req.header("Referer") ?? "";
  // The panel host serves pages anyone with a device token wrote. Nothing
  // from it is ever a form of ours, whatever else the comparison below says.
  const panel = panelOrigin(c.env);
  if (panel && (origin === panel || referer.startsWith(panel + "/"))) return false;
  if (origin) return origin === c.env.PUBLIC_URL;
  return referer.startsWith(c.env.PUBLIC_URL + "/");
}

/**
 * A backstop under every cookie-authenticated route that changes something.
 *
 * Each such route already calls sameOrigin() itself. This runs once, before
 * any of them, so that a route added later and written without the call is
 * still closed to another site, and so that the browser's own statement of
 * where a request came from (Sec-Fetch-Site) is consulted as well as the
 * Origin it sent. Either is enough to refuse.
 *
 * It only looks at requests the session cookie authenticated. A bearer token
 * is not something a browser attaches by itself, so a request carrying one
 * has no cross-site form to worry about, and the Mac's own calls (which send
 * no Origin at all) are left alone. GET, HEAD and OPTIONS are untouched:
 * nothing reachable by them changes state except through the routes that
 * guard themselves (GET /logout, the OAuth callback).
 *
 * Sec-Fetch-Site is absent from older browsers and from tools like curl; an
 * absent header falls back to the Origin/Referer check alone. When present, a
 * state-changing request must say same-origin: same-site (a sibling
 * subdomain, such as a panel host) is refused too.
 */
export const crossSiteGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (c.get("authKind") !== "session") return next();
  const site = c.req.header("Sec-Fetch-Site");
  if ((site !== undefined && site !== "same-origin") || !sameOrigin(c)) {
    return c.json({ error: "cross_origin" }, 403);
  }
  return next();
};

/**
 * Refuses a panel's device token on a route only a person should reach.
 *
 * Administering the account is not something a panel does on its owner's
 * behalf: connecting another Mac, removing one, disconnecting Drive, minting
 * a panel sign-in code. A device token is a credential that lives on a laptop
 * for months, and a copy of one used to be enough to enroll a replacement Mac
 * and remove the real one, which is the opposite of what revoking it should
 * do. Returns the refusal, or null to carry on.
 */
export function browserOnly(c: Context<AppEnv>): Response | null {
  if (c.get("authKind") !== "device") return null;
  return c.json(
    { error: "browser_session_required", detail: "Sign in at " + c.env.PUBLIC_URL + " to do this." },
    403,
  );
}
