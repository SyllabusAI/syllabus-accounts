/**
 * The session and sign-in flow cookies carry the __Host- prefix.
 *
 * A browser sets a __Host- cookie only when it is Secure, Path=/ and has no
 * Domain attribute, and no other host of the site can set one under that
 * name. That closes cookie tossing: a script on a sibling subdomain (a panel
 * host) planting a session cookie for a visitor who has none. A server cannot
 * see the Domain attribute of a cookie it receives, so what these tests can
 * show is that the server sets the cookie with the attributes the prefix
 * demands, no longer reads the names from before the prefix, and refuses two
 * cookies of one name.
 */

import { createExecutionContext, env } from "cloudflare:test";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { FLOW_COOKIE, hostCookieName, LEGACY_COOKIES, SESSION_COOKIE } from "../src/session";
import { toBase64Url } from "../src/util";
import { get, ORIGIN, signedInAs } from "./helpers";

const CLIENT = "test-client-id.apps.googleusercontent.com";
const [LEGACY_SESSION, LEGACY_FLOW] = LEGACY_COOKIES;

const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));

/** Every Set-Cookie on a response, one string each. */
function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}
const named = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(name + "="));

async function signed(name: string, value: unknown, secure = false) {
  return (await serializeSigned(name, JSON.stringify(value), env.SESSION_SECRET, secure ? { path: "/", secure: true } : { path: "/" })).split(";")[0];
}

afterEach(() => vi.unstubAllGlobals());

describe("the cookies as they are set", () => {
  it("names are prefixed, and Secure, Path=/, HttpOnly, SameSite=Lax with no Domain", async () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    expect(FLOW_COOKIE.startsWith("__Host-")).toBe(true);

    const login = await get("/login");
    const flow = named(login, FLOW_COOKIE)!;
    const { account } = await signedInAs("host-prefix@example.com");
    void account;

    // Through the real callback, so it is setSession's own cookie.
    const to = new URL(login.headers.get("Location")!);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id_token: `${enc({ alg: "RS256" })}.${enc({
              iss: "https://accounts.google.com",
              aud: CLIENT,
              sub: "host-prefix-sub",
              exp: Math.floor(Date.now() / 1000) + 300,
              nonce: to.searchParams.get("nonce"),
              email: "host-prefix@example.com",
              email_verified: true,
            })}.sig`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const cb = await get(`/oauth2/callback?state=${to.searchParams.get("state")}&code=x`, { Cookie: flow.split(";")[0] });
    expect(cb.status).toBe(302);

    for (const cookie of [flow, named(cb, SESSION_COOKIE)!]) {
      expect(cookie).toBeTruthy();
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; Path=\/(;|$)/i);
      expect(cookie).toMatch(/; HttpOnly/i);
      expect(cookie).toMatch(/; SameSite=Lax/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    // The flow cookie is expired by the callback, with the attributes the prefix needs.
    const gone = named(cb, FLOW_COOKIE)!;
    expect(gone).toMatch(/Max-Age=0/i);
    expect(gone).toMatch(/; Secure/i);
    expect(gone).toMatch(/; Path=\//i);
    // No cookie under either of the old names is ever set.
    for (const old of LEGACY_COOKIES) expect(setCookies(cb).some((c) => c.startsWith(old + "=") && !/Max-Age=0/i.test(c))).toBe(false);
  });

  it("sign-out expires the session cookie under its prefixed name, Secure and Path=/", async () => {
    const { cookie } = await signedInAs("host-logout@example.com");
    const res = await get("/logout", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
    const gone = named(res, SESSION_COOKIE)!;
    expect(gone).toMatch(/Max-Age=0/i);
    expect(gone).toMatch(/; Secure/i);
    expect(gone).toMatch(/; Path=\//i);
    expect(gone).not.toMatch(/Domain=/i);
  });
});

describe("the cookie names before the prefix", () => {
  it("no longer sign anyone in, and are expired on the response", async () => {
    const { account } = await signedInAs("legacy@example.com");
    const old = await signed(LEGACY_SESSION, { a: account.id, t: Date.now() });
    const me = await get("/me", { Cookie: old });
    expect(me.status).toBe(401);
    const gone = named(me, LEGACY_SESSION)!;
    expect(gone).toMatch(/Max-Age=0/i);
    // The landing page, not the account page.
    const home = await get("/", { Cookie: old });
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("legacy@example.com");
    // Nothing loops: a request with no cookie at all sets nothing.
    expect(setCookies(await get("/me"))).toEqual([]);
  });

  it("a request with both names is the new cookie's account alone, and the old one is expired", async () => {
    const mine = await signedInAs("both-new@example.com");
    const other = await signedInAs("both-old@example.com");
    const old = await signed(LEGACY_SESSION, { a: other.account.id, t: Date.now() });
    const me = await get("/me", { Cookie: `${old}; ${mine.cookie}` });
    expect(((await me.json()) as { account: { email: string } }).account.email).toBe("both-new@example.com");
    expect(named(me, LEGACY_SESSION)).toMatch(/Max-Age=0/i);
    expect(named(me, SESSION_COOKIE)).toBeUndefined();
  });

  it("an old-name sign-in flow cookie does not start a callback", async () => {
    const flow = { state: "s1", nonce: "n1", next: "/", t: Date.now(), verifier: "v" };
    const old = await signed(LEGACY_FLOW, flow);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await get("/oauth2/callback?state=s1&code=x", { Cookie: old });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a cookie planted for a visitor with no session", () => {
  it("two cookies of the session name sign nobody in, even when both are validly signed", async () => {
    const attacker = await signedInAs("attacker-session@example.com");
    const res = await get("/me", { Cookie: `${attacker.cookie}; ${attacker.cookie}` });
    expect(res.status).toBe(401);
    // One is the browser's own; the request is treated as signed out.
    expect((await get("/me", { Cookie: attacker.cookie })).status).toBe(200);
  });
});

describe("over http, for wrangler dev on localhost", () => {
  const dev = { ...(env as unknown as Bindings), PUBLIC_URL: "http://localhost:8787" };

  it("names its own cookies and does not claim Secure, so the browser accepts them", async () => {
    expect(hostCookieName(dev, SESSION_COOKIE)).toBe("syllabus_accounts_session_dev");
    expect(hostCookieName(dev, FLOW_COOKIE)).toBe("syllabus_accounts_signin_dev");
    const res = await worker.fetch(
      new Request("http://localhost:8787/login", { headers: { "CF-Connecting-IP": "198.51.100.200" }, redirect: "manual" }),
      dev,
      createExecutionContext(),
    );
    const cookie = named(res, "syllabus_accounts_signin_dev")!;
    expect(cookie).toBeTruthy();
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("over https the name is the prefixed one, never the dev one", () => {
    expect(hostCookieName({ PUBLIC_URL: ORIGIN }, SESSION_COOKIE)).toBe(SESSION_COOKIE);
  });
});
