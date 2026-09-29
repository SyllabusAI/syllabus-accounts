import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import type { AppEnv, Bindings } from "../src/env";
import worker from "../src/index";
import {
  AUTH_SEGMENT,
  mintTicket,
  PANEL_COOKIE,
  PANEL_CSP,
  panelOrigin,
  readTicket,
  TICKET_SECONDS,
} from "../src/panel-host";
import type { ReqFrame, ResFrame, WelcomeFrame } from "../src/panel-relay";
import { SESSION_COOKIE, setSession } from "../src/session";
import { fromBase64Url, toBase64 } from "../src/util";
import { claimDevice, get, ORIGIN, signedInAs } from "./helpers";

const PANEL = "https://panels.example";
const text = (s: string) => toBase64(new TextEncoder().encode(s));

/**
 * The Worker as it runs with PANEL_ORIGIN set (or set to `panel`).
 *
 * SELF runs with the bindings in vitest.config.ts, which leave PANEL_ORIGIN
 * unset so that every other test file exercises today's behavior. These go
 * through the entry module directly with one binding added; D1 and the
 * relay objects are the same ones SELF uses, so a panel connected through
 * SELF is the panel these reach.
 */
async function call(url: string, init: RequestInit = {}, panel: string = PANEL): Promise<Response> {
  const bindings = { ...(env as unknown as Bindings), PANEL_ORIGIN: panel };
  return await worker.fetch(new Request(url, { redirect: "manual", ...init }), bindings, createExecutionContext());
}

/** Open the panel's socket the way intake/relay.py does, answering every request with what it saw. */
async function connectPanel(token: string, extraHeaders: Record<string, string> = {}) {
  const res = await SELF.fetch(ORIGIN + "/relay/connect", { headers: { Upgrade: "websocket", Authorization: "Bearer " + token } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const seen: ReqFrame[] = [];
  const welcome = new Promise<WelcomeFrame>((resolve) => {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ReqFrame | WelcomeFrame;
      if (frame.t === "welcome") return resolve(frame);
      if (frame.t !== "req") return;
      seen.push(frame);
      const reply: ResFrame = {
        t: "res",
        id: frame.id,
        status: 200,
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: text(JSON.stringify({ path: frame.path, query: frame.query, viewer: frame.viewer, base: frame.base })),
      };
      ws.send(JSON.stringify(reply));
    });
  });
  // As in relay.test.ts: always wait for the close, or the pool hangs in teardown.
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
  const close = async () => {
    ws.close(1000, "done");
    await closed;
  };
  return { seen, welcome: await welcome, close };
}

/** The panel host's own cookie for a device, the way a browser would come by it. */
async function panelCookieFor(mine: { cookie: string; deviceId: string }, landing = "/") {
  const handed = await call(`${ORIGIN}/p/${mine.deviceId}${landing}`, { headers: { Cookie: mine.cookie } });
  expect(handed.status).toBe(302);
  const auth = await call(handed.headers.get("Location")!);
  expect(auth.status).toBe(302);
  const setCookie = auth.headers.get("Set-Cookie")!;
  return { handed, auth, setCookie, cookie: setCookie.split(";")[0] };
}

function ticketOf(location: string): string {
  return new URL(location).searchParams.get("t") ?? "";
}

describe("PANEL_ORIGIN, as configuration", () => {
  const at = (PANEL_ORIGIN: string | undefined, PUBLIC_URL = "https://accounts.example.com") => panelOrigin({ PUBLIC_URL, PANEL_ORIGIN });

  it("unset or empty means no panel host at all", () => {
    expect(at(undefined)).toBe("");
    expect(at("")).toBe("");
    expect(at("   ")).toBe("");
  });

  it("is an origin, normalized", () => {
    expect(at("https://panels.example.net")).toBe("https://panels.example.net");
    expect(at("https://panels.example.net/")).toBe("https://panels.example.net");
    expect(at("https://Panels.Example.NET")).toBe("https://panels.example.net");
    expect(at("https://syllabus-accounts.someone.workers.dev")).toBe("https://syllabus-accounts.someone.workers.dev");
    // A sibling subdomain is a different origin, so it is allowed; see env.ts for why a separate site is better.
    expect(at("https://panels.example.com")).toBe("https://panels.example.com");
  });

  it("refuses the account host itself, a parent of it, or a subdomain of it", () => {
    expect(at("https://accounts.example.com")).toBeNull();
    expect(at("http://accounts.example.com")).toBeNull();
    expect(at("https://accounts.example.com:8443")).toBeNull();
    expect(at("https://p.accounts.example.com")).toBeNull();
    expect(at("https://example.com")).toBeNull();
  });

  it("refuses anything that is not a plain https origin", () => {
    expect(at("https://panels.example.net/p")).toBeNull();
    expect(at("https://panels.example.net/?x=1")).toBeNull();
    expect(at("https://user:pw@panels.example.net")).toBeNull();
    expect(at("http://panels.example.net")).toBeNull();
    expect(at("panels.example.net")).toBeNull();
    expect(at("javascript:alert(1)")).toBeNull();
    // Plain http is fine only when the account host is too: local development.
    expect(at("http://127.0.0.1:8788", "http://localhost:8787")).toBe("http://127.0.0.1:8788");
  });
});

describe("with PANEL_ORIGIN unset, nothing changes", () => {
  it("serves the panel from the account host, as before", async () => {
    const mine = await claimDevice("me@example.com");
    const { close } = await connectPanel(mine.token);
    const res = await call(`${ORIGIN}/p/${mine.deviceId}/api/status`, { headers: { Cookie: mine.cookie } }, "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { viewer: unknown }).viewer).toEqual({ email: "me@example.com", account_id: mine.account.id });
    await close();
  });

  it("does not treat any other host as a panel host", async () => {
    const res = await call(`${PANEL}/healthz`, {}, "");
    expect(res.status).toBe(200);
  });

  it("tells the panel its address on the account host", async () => {
    const mine = await claimDevice("me@example.com");
    const { welcome, close } = await connectPanel(mine.token);
    expect(welcome.panel_url).toBe(`${ORIGIN}/p/${mine.deviceId}/`);
    await close();
  });
});

describe("the account host, with a panel host", () => {
  it("sends a signed-out visitor to sign in, and back to the same panel address", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await call(`${ORIGIN}/p/${mine.deviceId}/setup?x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?next=" + encodeURIComponent(`/p/${mine.deviceId}/setup?x=1`));
    expect((await call(`${ORIGIN}/p/${mine.deviceId}/api/status`)).status).toBe(401);
  });

  it("hands the owner across to the panel host with a ticket, and serves no panel content itself", async () => {
    const mine = await claimDevice("me@example.com");
    const { seen, close } = await connectPanel(mine.token);
    const res = await call(`${ORIGIN}/p/${mine.deviceId}/setup?x=1`, { headers: { Cookie: mine.cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe(PANEL);
    expect(location.pathname).toBe(`/p/${mine.deviceId}/${AUTH_SEGMENT}`);
    expect(ticketOf(location.href)).not.toBe("");
    // An API GET is handed across too, and no path of the account host relays anything.
    expect((await call(`${ORIGIN}/p/${mine.deviceId}/api/status`, { headers: { Cookie: mine.cookie } })).status).toBe(302);
    const post = await call(`${ORIGIN}/p/${mine.deviceId}/api/record/start`, {
      method: "POST",
      headers: { Cookie: mine.cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(post.status).toBe(421);
    expect(((await post.json()) as { panel: string }).panel).toBe(`${PANEL}/p/${mine.deviceId}/`);
    expect(seen).toHaveLength(0);
    await close();
  });

  it("mints no ticket for someone else's Mac, an unknown one, or a device token", async () => {
    const mine = await claimDevice("me@example.com");
    const other = await signedInAs("other@example.com");
    const theirs = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Cookie: other.cookie } });
    expect(theirs.status).toBe(403);
    expect(theirs.headers.get("Location")).toBeNull();
    expect((await call(`${ORIGIN}/p/nosuchdevice/`, { headers: { Cookie: mine.cookie } })).status).toBe(404);
    const bearer = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Authorization: "Bearer " + mine.token } });
    expect(bearer.status).toBe(302);
    expect(bearer.headers.get("Location")!.startsWith("/login")).toBe(true);
  });

  it("refuses to relay anywhere when PANEL_ORIGIN is unusable", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Cookie: mine.cookie } }, ORIGIN);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("panel_host_misconfigured");
  });

  it("takes no form posted from the panel host", async () => {
    const mine = await claimDevice("me@example.com");
    const other = await claimDevice("me@example.com", "Second Mac");
    // Everything an account form checks, correct, except that it came from the panel host.
    const fromPanel: Record<string, string>[] = [{ Origin: PANEL }, { Referer: `${PANEL}/p/${mine.deviceId}/` }];
    for (const headers of fromPanel) {
      const res = await call(`${ORIGIN}/devices/${other.deviceId}/revoke`, {
        method: "POST",
        headers: { Cookie: mine.cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: "",
      });
      expect(res.status).toBe(403);
    }
    const fine = await call(`${ORIGIN}/devices/${other.deviceId}/revoke`, {
      method: "POST",
      headers: { Cookie: mine.cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: "",
    });
    expect(fine.status).toBe(302);
  });

  it("reads two session cookies as nobody, since one of them was not set by this host", async () => {
    const mine = await signedInAs("me@example.com");
    const theirs = await signedInAs("attacker@example.com");
    expect((await call(`${ORIGIN}/me`, { headers: { Cookie: mine.cookie } })).status).toBe(200);
    const both = await call(`${ORIGIN}/me`, { headers: { Cookie: `${theirs.cookie}; ${mine.cookie}` } });
    expect(both.status).toBe(401);
  });
});

describe("the ticket", () => {
  it("lands the owner on their panel, with its own cookie and the ticket gone from the address", async () => {
    const mine = await claimDevice("me@example.com");
    const { auth, setCookie } = await panelCookieFor(mine, "/setup?x=1");
    expect(auth.headers.get("Location")).toBe(`/p/${mine.deviceId}/setup?x=1`);
    expect(auth.headers.get("Cache-Control")).toBe("no-store");
    expect(auth.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(setCookie.startsWith(PANEL_COOKIE + "=")).toBe(true);
    const attrs = setCookie.split(";").map((p) => p.trim().toLowerCase());
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).toContain(`path=/p/${mine.deviceId.toLowerCase()}/`);
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
    expect(attrs).toContain("max-age=43200");
  });

  it("is single-use", async () => {
    const mine = await claimDevice("me@example.com");
    const handed = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Cookie: mine.cookie } });
    const location = handed.headers.get("Location")!;
    expect((await call(location)).status).toBe(302);
    const again = await call(location);
    expect(again.status).toBe(403);
    expect(again.headers.get("Set-Cookie")).toBeNull();
    expect(await again.text()).toContain("already been used or has expired");
  });

  it("expires after a minute, and a far-future one is not believed either", async () => {
    const mine = await claimDevice("me@example.com");
    const stale = await mintTicket(env.SESSION_SECRET, mine.account.id, mine.deviceId, "/", Date.now() - (TICKET_SECONDS + 1) * 1000);
    const res = await call(`${PANEL}/p/${mine.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(stale)}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const future = await mintTicket(env.SESSION_SECRET, mine.account.id, mine.deviceId, "/", Date.now() + 3600 * 1000);
    expect(await readTicket(env.SESSION_SECRET, future, mine.deviceId)).toEqual({ error: "expired" });
    const fresh = await mintTicket(env.SESSION_SECRET, mine.account.id, mine.deviceId, "/");
    expect("ticket" in (await readTicket(env.SESSION_SECRET, fresh, mine.deviceId))).toBe(true);
  });

  it("is refused at another device's address", async () => {
    const mine = await claimDevice("me@example.com");
    const second = await claimDevice("me@example.com", "Second Mac");
    const handed = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Cookie: mine.cookie } });
    const ticket = ticketOf(handed.headers.get("Location")!);
    const res = await call(`${PANEL}/p/${second.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // Refused before it was spent, so the right address still takes it.
    expect((await call(`${PANEL}/p/${mine.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(ticket)}`)).status).toBe(302);
  });

  it("is refused for a device that is not the named account's", async () => {
    const mine = await claimDevice("me@example.com");
    const other = await signedInAs("other@example.com");
    const ticket = await mintTicket(env.SESSION_SECRET, other.account.id, mine.deviceId, "/");
    const res = await call(`${PANEL}/p/${mine.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("cannot be forged, altered, or made from another secret or another cookie", async () => {
    const mine = await claimDevice("me@example.com");
    const other = await signedInAs("other@example.com");
    const real = await mintTicket(env.SESSION_SECRET, other.account.id, "someone-elses", "/");
    const [payload, mac] = real.split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    const altered = btoa(JSON.stringify({ ...claims, a: mine.account.id, d: mine.deviceId })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const session = (await serializeSigned(SESSION_COOKIE, JSON.stringify({ a: mine.account.id, t: Date.now() }), env.SESSION_SECRET, { path: "/", secure: true })).split(";")[0].split("=").slice(1).join("=");
    const attempts = [
      "",
      "garbage",
      "a.b.c",
      `${altered}.${mac}`,
      `${altered}.${"A".repeat(43)}`,
      await mintTicket("some-other-secret", mine.account.id, mine.deviceId, "/"),
      decodeURIComponent(session),
    ];
    for (const t of attempts) {
      const res = await call(`${PANEL}/p/${mine.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(t)}`);
      expect(res.status, `ticket ${t}`).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  it("only ever lands on the panel host's own paths", async () => {
    const mine = await claimDevice("me@example.com");
    for (const landing of ["//evil.example/", "https://evil.example/", "\\\\evil.example"]) {
      const ticket = await mintTicket(env.SESSION_SECRET, mine.account.id, mine.deviceId, landing);
      const res = await call(`${PANEL}/p/${mine.deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(ticket)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/p/${mine.deviceId}/`);
    }
  });
});

describe("the panel host", () => {
  it("keeps a policy the panel sends, adds its own beside it, and drops other headers", async () => {
    const mine = await claimDevice("csp-panel@example.com", "My Mac");
    const panelPolicy = "default-src 'none'; script-src 'nonce-abc'; connect-src 'self'";
    const { close } = await connectPanel(mine.token, { "Content-Security-Policy": panelPolicy, "X-Internal": "hide me" });
    const { cookie } = await panelCookieFor(mine);
    const res = await call(`${PANEL}/p/${mine.deviceId}/api/status`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    // Both policies reach the browser, which enforces each; neither replaces the other.
    expect(res.headers.get("Content-Security-Policy")).toBe(`${panelPolicy}, ${PANEL_CSP}`);
    expect(res.headers.get("X-Internal")).toBeNull();
    await close();
  });

  it("keeps a policy the panel sends when the panel is reached on the account host", async () => {
    const mine = await claimDevice("csp-panel2@example.com", "My Mac");
    const panelPolicy = "default-src 'none'; script-src 'nonce-xyz'";
    const { close } = await connectPanel(mine.token, { "Content-Security-Policy": panelPolicy });
    const res = await get(`/p/${mine.deviceId}/api/status`, { Cookie: mine.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(panelPolicy);
    await close();
  });

  it("relays for the viewer its cookie names, with the panel's headers", async () => {
    const mine = await claimDevice("me@example.com", "My Mac");
    const { seen, close } = await connectPanel(mine.token);
    const { cookie } = await panelCookieFor(mine);
    const res = await call(`${PANEL}/p/${mine.deviceId}/api/status?since=1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewer: unknown; path: string; query: string; base: string };
    expect(body.viewer).toEqual({ email: "me@example.com", account_id: mine.account.id });
    expect(body.path).toBe("/api/status");
    expect(body.query).toBe("since=1");
    expect(body.base).toBe(`/p/${mine.deviceId}`);
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(res.headers.get("Content-Security-Policy")).toBe(PANEL_CSP);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    // The CSP must leave the panel's inline scripts alone.
    expect(PANEL_CSP).not.toContain("script-src");
    expect(PANEL_CSP).not.toContain("default-src");
    await close();
  });

  it("takes a POST from itself and refuses one from the account host or anywhere else", async () => {
    const mine = await claimDevice("me@example.com");
    const { close } = await connectPanel(mine.token);
    const { cookie } = await panelCookieFor(mine);
    const post = (origin: string) =>
      call(`${PANEL}/p/${mine.deviceId}/api/record/start`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
    expect((await post(PANEL)).status).toBe(200);
    expect((await post(ORIGIN)).status).toBe(403);
    expect((await post("https://evil.example")).status).toBe(403);
    await close();
  });

  it("sends a page visitor without its cookie back to the account host, and refuses the API", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await call(`${PANEL}/p/${mine.deviceId}/setup?x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/p/${mine.deviceId}/setup?x=1`);
    expect((await call(`${PANEL}/p/${mine.deviceId}/api/status`)).status).toBe(401);
  });

  it("does not take the account session cookie, a forged cookie, another device's cookie, or two cookies", async () => {
    const mine = await claimDevice("me@example.com");
    const second = await claimDevice("me@example.com", "Second Mac");
    const { cookie } = await panelCookieFor(mine);
    const forged = (await serializeSigned(PANEL_COOKIE, JSON.stringify({ a: mine.account.id, d: mine.deviceId, v: 0, t: Date.now() }), env.SESSION_SECRET)).split(";")[0];
    for (const c of [mine.cookie, forged, `${cookie}; ${cookie}`]) {
      expect((await call(`${PANEL}/p/${mine.deviceId}/api/status`, { headers: { Cookie: c } })).status, c).toBe(401);
    }
    // A browser would not send it at the other path; a script that sends it anyway gets nothing.
    expect((await call(`${PANEL}/p/${second.deviceId}/api/status`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("stops serving a viewer whose Mac was removed, or who signed every Mac out", async () => {
    const mine = await claimDevice("me@example.com");
    const { cookie } = await panelCookieFor(mine);
    await call(`${ORIGIN}/devices/${mine.deviceId}/revoke`, { method: "POST", headers: { Cookie: mine.cookie, Origin: ORIGIN } });
    expect((await call(`${PANEL}/p/${mine.deviceId}/api/status`, { headers: { Cookie: cookie } })).status).toBe(404);

    const again = await claimDevice("again@example.com");
    const kept = await panelCookieFor(again);
    await call(`${ORIGIN}/devices/revoke-all`, { method: "POST", headers: { Cookie: again.cookie, Origin: ORIGIN } });
    expect((await call(`${PANEL}/p/${again.deviceId}/api/status`, { headers: { Cookie: kept.cookie } })).status).toBe(401);
  });

  it("answers 404 for every account, billing and device route, signed in or not", async () => {
    const mine = await claimDevice("me@example.com");
    const { cookie } = await panelCookieFor(mine);
    const everyone = [mine.cookie, cookie, `${mine.cookie}; ${cookie}`].join("; ");
    const routes: Array<[string, string]> = [
      ["GET", "/"],
      ["GET", "/me"],
      ["GET", "/healthz"],
      ["GET", "/login"],
      ["GET", "/logout"],
      ["GET", "/device"],
      ["POST", "/device/start"],
      ["POST", "/device/approve"],
      ["POST", "/device/poll"],
      ["POST", "/device/revoke"],
      ["POST", `/devices/${mine.deviceId}/revoke`],
      ["POST", "/devices/revoke-all"],
      ["GET", "/drive/connect"],
      ["GET", "/drive/status"],
      ["POST", "/drive/token"],
      ["POST", "/drive/disconnect"],
      ["POST", "/billing/checkout"],
      ["POST", "/billing/portal"],
      ["POST", "/billing/topup"],
      ["POST", "/stripe/webhook"],
      ["GET", "/relay/connect"],
      ["GET", "/settings/x"],
      ["POST", "/proxy/summarize"],
      ["GET", "/proxy/usage"],
      ["GET", "/privacy"],
    ];
    for (const [method, path] of routes) {
      const callers: Record<string, string>[] = [{ Cookie: everyone, Origin: PANEL }, { Authorization: "Bearer " + mine.token }];
      for (const headers of callers) {
        const res = await call(PANEL + path, { method, headers, body: method === "POST" ? "" : undefined });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get("Set-Cookie"), `${method} ${path}`).toBeNull();
      }
    }
  });

  it("does not let a device token act as a viewer", async () => {
    const mine = await claimDevice("me@example.com");
    const res = await call(`${PANEL}/p/${mine.deviceId}/api/status`, { headers: { Authorization: "Bearer " + mine.token } });
    expect(res.status).toBe(401);
  });
});

describe("the account session cookie", () => {
  it("is host-only, so it never reaches a panel host", async () => {
    const app = new Hono<AppEnv>();
    app.get("/", async (c) => {
      await setSession(c, { id: "acct-1", session_version: 0 });
      return c.text("ok");
    });
    const res = await app.request("/", {}, { ...(env as unknown as Bindings), PUBLIC_URL: ORIGIN });
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie.startsWith(SESSION_COOKIE + "=")).toBe(true);
    const attrs = setCookie.split(";").map((p) => p.trim().toLowerCase());
    expect(attrs.some((a) => a.startsWith("domain"))).toBe(false);
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("path=/");
  });
});
