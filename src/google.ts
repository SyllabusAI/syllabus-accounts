/**
 * Sign in with Google: plain OpenID Connect, with nothing but fetch.
 *
 *   /login            remembers where you were going, sends you to Google
 *   /oauth2/callback  trades the code for an ID token, checks it, sets the session
 *   /logout           clears the session
 *
 * The state, nonce, and PKCE verifier ride in a short-lived signed cookie
 * between the two. State ties the callback to the browser that started it,
 * the nonce ties the ID token to it, and PKCE (S256) ties the code: a code
 * lifted from somebody else's redirect cannot be redeemed without the
 * verifier, which never leaves this service and that browser's cookie.
 * The ID token arrives straight from Google's token endpoint over TLS, so
 * its signature is not re-checked here (OpenID Connect Core 3.1.3.7 allows
 * that for a token received over the direct token-endpoint connection); the
 * issuer, audience, expiry, nonce, and email_verified claims are.
 */

import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { applyTrialBlock } from "./account";
import { upsertAccount } from "./db";
import { finishConnect } from "./drive";
import type { AppEnv } from "./env";
import { page } from "./pages";
import { clientAddress, LIMITS, limitedPage, overLimit } from "./limits";
import { log } from "./log";
import { countCookie } from "./panel-host";
import { clearHostCookie, clearSession, cookieSecure, FLOW_COOKIE, hostCookieName, sameOrigin, sessionSecret, setSession } from "./session";
import { fromBase64Url, randomId, toBase64Url } from "./util";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALLBACK_PATH = "/oauth2/callback";

const FLOW_SECONDS = 600;

export type Flow = {
  state: string;
  nonce: string;
  next: string;
  t: number;
  kind?: "signin" | "drive";
  /** The PKCE code_verifier. Only its S256 hash goes to Google with the user. */
  verifier?: string;
};

/**
 * A path on this site to return to after signing in, never elsewhere.
 *
 * Checking the first characters is not enough on its own: a browser reads
 * "/\evil.test" and "/<tab>/evil.test" as "//evil.test", which is another
 * host. So the value is resolved the way a browser would resolve it, and
 * only kept when it lands on this origin; what is returned is rebuilt from
 * the parsed path, never the raw input.
 */
export function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  // Backslashes and control characters have no business in a path we wrote,
  // and each is a way to make a browser see a second slash.
  if (/[\\\x00-\x1f\x7f]/.test(value)) return "/";
  const base = "https://this-site.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  return url.pathname + url.search + url.hash;
}

/** A fresh PKCE verifier and its S256 challenge (RFC 7636). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomId(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export function redirectUri(publicUrl: string): string {
  return publicUrl.replace(/\/$/, "") + CALLBACK_PATH;
}

export type IdClaims = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export function decodeClaims(idToken: string): IdClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("ID token is not a JWT");
  const json = new TextDecoder().decode(fromBase64Url(parts[1]));
  return JSON.parse(json) as IdClaims;
}

/** Throws with a reason when the claims are not a fresh Google token for us. */
export function checkClaims(claims: IdClaims, clientId: string, nonce: string, nowSeconds = Date.now() / 1000): void {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error(`unexpected issuer ${claims.iss}`);
  }
  if (claims.aud !== clientId) throw new Error("token was issued for another client");
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) throw new Error("token has expired");
  if (claims.nonce !== nonce) throw new Error("nonce does not match the sign-in that was started");
  if (!claims.sub) throw new Error("token names no subject");
  if (!claims.email || !claims.email_verified) throw new Error("account has no verified email");
}

export const google = new Hono<AppEnv>();

google.get("/login", async (c) => {
  const wait = await overLimit(c, `login:${clientAddress(c)}`, LIMITS.login);
  if (wait !== null) return limitedPage(c, wait);
  const pkce = await pkcePair();
  const flow: Flow = {
    state: randomId(18),
    nonce: randomId(18),
    next: safeNext(c.req.query("next")),
    t: Date.now(),
    verifier: pkce.verifier,
  };
  await setSignedCookie(c, hostCookieName(c.env, FLOW_COOKIE), JSON.stringify(flow), sessionSecret(c), {
    path: "/",
    httpOnly: true,
    secure: cookieSecure(c.env),
    sameSite: "Lax",
    maxAge: FLOW_SECONDS,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c.env.PUBLIC_URL),
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return c.redirect(`${AUTH_URL}?${params}`);
});

google.get(CALLBACK_PATH, async (c) => {
  const wait = await overLimit(c, `callback:${clientAddress(c)}`, LIMITS.callback);
  if (wait !== null) return limitedPage(c, wait);
  // Two cookies of this name mean one was planted from another host of this
  // site (a panel host on a sibling subdomain, say) with a Domain attribute.
  // It could be a sign-in the attacker started, which would sign this browser
  // in as the attacker's account, so neither is trusted (as in session.ts).
  const flowName = hostCookieName(c.env, FLOW_COOKIE);
  const planted = countCookie(c.req.header("Cookie") ?? "", flowName) > 1;
  const raw = planted ? undefined : await getSignedCookie(c, sessionSecret(c), flowName);
  let flow: Flow | null = null;
  try {
    flow = raw ? (JSON.parse(raw) as Flow) : null;
  } catch {
    flow = null;
  }
  // A flow without a verifier was started by the code before PKCE, in the
  // ten minutes before a deploy; it is simply started again.
  if (!flow || !flow.verifier || Date.now() - flow.t > FLOW_SECONDS * 1000 || c.req.query("state") !== flow.state) {
    return c.html(page("Sign in", "<p>That sign-in took too long or did not start here.</p><p><a href='/login'>Try again</a></p>"), 400);
  }
  if (c.req.query("error")) {
    return c.html(page("Sign in", "<p>Google did not complete the sign-in.</p><p><a href='/login'>Try again</a></p>"), 400);
  }
  const code = c.req.query("code") ?? "";
  if (!code) {
    return c.html(page("Sign in", "<p>Google sent no code back.</p><p><a href='/login'>Try again</a></p>"), 400);
  }
  if (flow.kind === "drive") {
    clearHostCookie(c, FLOW_COOKIE);
    return finishConnect(c, flow, code);
  }

  let claims: IdClaims;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(c.env.PUBLIC_URL),
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error("token endpoint returned no ID token");
    claims = decodeClaims(body.id_token);
    checkClaims(claims, c.env.GOOGLE_CLIENT_ID, flow.nonce);
  } catch (err) {
    log(`sign-in failed: ${(err as Error).message}`);
    return c.html(page("Sign in", "<p>The sign-in could not be checked with Google.</p><p><a href='/login'>Try again</a></p>"), 502);
  }

  const account = await upsertAccount(c.env.DB, {
    sub: claims.sub,
    email: claims.email!.toLowerCase(),
    name: claims.name ?? "",
    picture: claims.picture ?? "",
  });
  // A Google identity that deleted an account after its trial gets no second one.
  await applyTrialBlock(c.env, account.id, claims.sub);
  log(`signed in: account ${account.id}`);
  clearHostCookie(c, FLOW_COOKIE);
  await setSession(c, account);
  return c.redirect(flow.next);
});

function signOut(c: Context<AppEnv>) {
  clearSession(c);
  clearHostCookie(c, FLOW_COOKIE);
  return c.html(page("Signed out", "<p>You are signed out.</p><p><a href='/login'>Sign in</a></p>"));
}

/**
 * Signing out is a state change, so another site must not be able to do it.
 *
 * The account page posts a form, which sameOrigin() checks like every other
 * form here. A relayed panel links to GET /logout from this same origin, so
 * a GET is honored when the browser says the navigation came from this site
 * (Sec-Fetch-Site: same-origin) or from the person typing it (none). A GET
 * from anywhere else, or from a browser too old to say, gets a button
 * instead of a sign-out.
 */
google.get("/logout", (c) => {
  const site = c.req.header("Sec-Fetch-Site") ?? "";
  if (site === "same-origin" || site === "none") return signOut(c);
  return c.html(
    page("Sign out", `<form method="post" action="/logout"><button class="primary">Sign out</button></form>
      <p class="muted"><a href="/">Stay signed in</a></p>`),
  );
});

google.post("/logout", (c) => {
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  return signOut(c);
});
