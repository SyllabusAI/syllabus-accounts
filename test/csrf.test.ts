/**
 * Cross-site request forgery, route by route.
 *
 * The session cookie is SameSite=Lax, which keeps it off a cross-site form
 * POST but not off a request from a sibling host of the same site (a panel
 * host on a subdomain, another Main Course Media property), and Lax is a
 * browser default some clients do not apply. So every route the cookie
 * authenticates and that changes something must refuse on its own evidence:
 * the Origin the browser sent and, where it sends one, Sec-Fetch-Site.
 *
 * Each attack below is a request a browser would really make on an attacker's
 * behalf, carrying the victim's cookie. Each route's own side effect is
 * checked afterward, so a 403 that arrived after the damage would not pass.
 */

import { env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import type { AppEnv } from "../src/env";
import { crossSiteGuard } from "../src/session";
import { encrypt } from "../src/crypto";
import { claimDevice, get, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

type Headers_ = Record<string, string>;

/** What each attacker's page can make a browser send, on top of the cookie. */
const ATTACKS: [string, Headers_][] = [
  ["a foreign site", { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" }],
  ["a foreign site that hides its origin", { Origin: "null", "Sec-Fetch-Site": "cross-site" }],
  ["a foreign site, origin only", { Origin: "https://evil.test" }],
  ["a foreign referrer and no origin", { Referer: "https://evil.test/page" }],
  ["a request with no origin or referrer at all", {}],
  ["a sibling subdomain", { Origin: "https://panels.accounts.test", "Sec-Fetch-Site": "same-site" }],
  ["a sibling subdomain, origin only", { Origin: "https://panels.accounts.test" }],
  ["the parent domain", { Origin: "https://test", "Sec-Fetch-Site": "same-site" }],
  ["the same host on http", { Origin: "http://accounts.test" }],
  // The next two cannot come from a browser today, since it sends a foreign
  // Origin along with either value; they pin that Sec-Fetch-Site alone
  // refuses, so loosening the Origin comparison would not open anything.
  ["same-site, whatever Origin says", { Origin: ORIGIN, "Sec-Fetch-Site": "same-site" }],
  ["cross-site, whatever Origin says", { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" }],
];

const CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=x",
  "text/plain",
  "application/json",
];

/** The fields a route's honest form carries, sent as `type` claims to be. */
function bodyFor(type: string, fields: Record<string, string>): string {
  if (type === "application/json") return JSON.stringify(fields);
  if (type.startsWith("multipart/")) {
    return Object.entries(fields)
      .map(([k, v]) => `--x\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join("") + "--x--\r\n";
  }
  if (type === "text/plain") return Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n");
  return new URLSearchParams(fields).toString();
}

type Victim = {
  cookie: string;
  path: string;
  fields: Record<string, string>;
  /** Throws if the route's side effect happened. */
  untouched: () => Promise<void>;
};

const routes: Record<string, (n: number) => Promise<Victim>> = {
  "POST /logout": async (n) => {
    const { cookie } = await signedInAs(`csrf-logout-${n}@example.com`);
    return { cookie, path: "/logout", fields: {}, untouched: async () => {} };
  },
  "POST /device/approve": async (n) => {
    const { cookie } = await signedInAs(`csrf-approve-${n}@example.com`);
    const started = (await (await postJson("/device/start", { name: "Attacker Mac", profile: "syllabus" })).json()) as {
      device_code: string;
      user_code: string;
    };
    return {
      cookie,
      path: "/device/approve",
      fields: { user_code: started.user_code },
      untouched: async () => {
        const polled = await postJson("/device/poll", { device_code: started.device_code });
        expect(((await polled.json()) as { error?: string }).error).toBe("authorization_pending");
      },
    };
  },
  "POST /devices/:id/revoke": async (n) => {
    const mine = await claimDevice(`csrf-revoke-${n}@example.com`);
    return {
      cookie: mine.cookie,
      path: `/devices/${mine.deviceId}/revoke`,
      fields: {},
      untouched: async () => {
        expect((await get("/me", { Authorization: "Bearer " + mine.token })).status).toBe(200);
      },
    };
  },
  "POST /devices/revoke-all": async (n) => {
    const mine = await claimDevice(`csrf-revoke-all-${n}@example.com`);
    return {
      cookie: mine.cookie,
      path: "/devices/revoke-all",
      fields: {},
      untouched: async () => {
        expect((await get("/me", { Authorization: "Bearer " + mine.token })).status).toBe(200);
      },
    };
  },
  "POST /drive/disconnect": async (n) => {
    const { account, cookie } = await signedInAs(`csrf-drive-${n}@example.com`);
    await db.putDriveGrant(env.DB, account.id, await encrypt(env.DRIVE_KEY, "1//refresh"), "drive.file", "me@gmail.com");
    return {
      cookie,
      path: "/drive/disconnect",
      fields: {},
      untouched: async () => {
        expect(await db.driveGrant(env.DB, account.id)).not.toBeNull();
      },
    };
  },
  "POST /account/delete": async (n) => {
    const email = `csrf-delete-${n}@example.com`;
    const { account, cookie } = await signedInAs(email);
    return {
      cookie,
      path: "/account/delete",
      fields: { confirm_email: email },
      untouched: async () => {
        expect(await db.accountById(env.DB, account.id)).not.toBeNull();
      },
    };
  },
  "POST /billing/checkout": async (n) => {
    const { cookie } = await signedInAs(`csrf-checkout-${n}@example.com`);
    return { cookie, path: "/billing/checkout", fields: { tier: "pro" }, untouched: async () => {} };
  },
  "POST /billing/portal": async (n) => {
    const { cookie } = await signedInAs(`csrf-portal-${n}@example.com`);
    return { cookie, path: "/billing/portal", fields: {}, untouched: async () => {} };
  },
  "POST /billing/topup": async (n) => {
    const { cookie } = await signedInAs(`csrf-topup-${n}@example.com`);
    return { cookie, path: "/billing/topup", fields: {}, untouched: async () => {} };
  },
  "POST /p/:device/api/* (relay, no panel host)": async (n) => {
    const mine = await claimDevice(`csrf-relay-${n}@example.com`);
    return { cookie: mine.cookie, path: `/p/${mine.deviceId}/api/record/start`, fields: { course: "X" }, untouched: async () => {} };
  },
};

let counter = 0;
let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  // Nothing here may reach Google or Stripe: a forged request that got as far
  // as an outbound call has already gone too far.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 500 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function send(v: Victim, type: string, headers: Headers_) {
  return SELF.fetch(ORIGIN + v.path, {
    method: "POST",
    headers: { Cookie: v.cookie, "Content-Type": type, "CF-Connecting-IP": `198.51.100.${(++counter % 250) + 1}:${counter}`, ...headers },
    body: bodyFor(type, v.fields),
    redirect: "manual",
  });
}

describe("every cookie-authenticated route that changes something refuses another site", () => {
  for (const [name, setup] of Object.entries(routes)) {
    it(name, async () => {
      // One victim per route: every attack is refused, so the victim's state
      // is what it was, and the side effect is checked once at the end.
      const victim = await setup(++counter);
      for (const [who, headers] of ATTACKS) {
        for (const type of CONTENT_TYPES) {
          const res = await send(victim, type, headers);
          expect(res.status, `${who} as ${type}`).toBe(403);
          expect(res.headers.get("Set-Cookie") ?? "", `${who} as ${type}`).toBe("");
        }
      }
      await victim.untouched();
      expect(fetched).toEqual([]);
    });
  }

  it("still lets the same page post its own form", async () => {
    // Otherwise every refusal above proves nothing. Delete is left out (it
    // would really delete); it gets a wrong confirmation, which is refused
    // for that reason and not for where it came from.
    for (const [name, setup] of Object.entries(routes)) {
      const victim = await setup(++counter);
      if (name === "POST /account/delete") victim.fields = { confirm_email: "someone-else@example.com" };
      const honest: Headers_[] = [{ Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }, { Origin: ORIGIN }, { Referer: ORIGIN + "/" }];
      for (const headers of honest) {
        const res = await send(victim, "application/x-www-form-urlencoded", headers);
        expect(res.status, `${name} with ${JSON.stringify(headers)}`).not.toBe(403);
      }
    }
  }, 60_000);
});

describe("routes a cookie cannot drive at all", () => {
  // These answer only to a device token. A browser holding the session cookie
  // reaches them with a correct Origin and is still turned away, so there is
  // no cross-site form to forge against them.
  const bearerOnly: [string, string][] = [
    ["PUT", "/settings/prompts"],
    ["POST", "/proxy/transcribe"],
    ["POST", "/proxy/summarize"],
    ["POST", "/proxy/assistant"],
    ["POST", "/drive/token"],
    ["POST", "/device/revoke"],
    ["GET", "/relay/connect"],
  ];

  for (const [method, path] of bearerOnly) {
    it(`${method} ${path}`, async () => {
      const { cookie } = await signedInAs(`csrf-bearer-${++counter}@example.com`);
      const res = await SELF.fetch(ORIGIN + path, {
        method,
        headers: { Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${(++counter % 250) + 1}:${counter}` },
        body: method === "GET" ? undefined : "{}",
        redirect: "manual",
      });
      expect(res.status).toBe(401);
      expect(fetched).toEqual([]);
    });
  }

  it("refuses a device token's request whatever site it claims to come from, because it is not a cookie", async () => {
    // The guard is for cookies. A bearer token is never attached by a browser
    // on its own, so it is not asked where it came from.
    const mine = await claimDevice("csrf-bearer-ok@example.com");
    const res = await postJson("/device/revoke", {}, { Authorization: "Bearer " + mine.token, Origin: "https://evil.test" });
    expect(res.status).toBe(200);
  });
});

describe("routes that change state on a GET", () => {
  it("GET /logout signs out only for a navigation from this site or typed in", async () => {
    const { cookie } = await signedInAs("csrf-get-logout@example.com");
    for (const site of ["cross-site", "same-site", undefined]) {
      const res = await get("/logout", { Cookie: cookie, ...(site ? { "Sec-Fetch-Site": site } : {}) });
      expect(res.headers.get("Set-Cookie"), String(site)).toBeNull();
    }
    expect((await get("/logout", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" })).headers.get("Set-Cookie")).toContain("__Host-syllabus_accounts_session=");
  });

  it("GET /device only reads, whichever site sent it", async () => {
    const { cookie, account } = await signedInAs("csrf-get-device@example.com");
    const started = (await (await postJson("/device/start", { name: "Some Mac", profile: "syllabus" })).json()) as { device_code: string; user_code: string };
    const res = await get(`/device?code=${started.user_code}`, { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(200);
    expect(await db.devicesOf(env.DB, account.id)).toEqual([]);
    const polled = await postJson("/device/poll", { device_code: started.device_code });
    expect(((await polled.json()) as { error?: string }).error).toBe("authorization_pending");
  });

  it("GET /drive/connect and /login only start a consent the person completes at Google", async () => {
    const { cookie, account } = await signedInAs("csrf-get-connect@example.com");
    const res = await get("/drive/connect", { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("https://accounts.google.com/");
    expect(await db.driveGrant(env.DB, account.id)).toBeNull();
    expect(fetched).toEqual([]);
  });
});

describe("a sign-in cannot be finished with a cookie planted by a sibling host", () => {
  // The flow cookie is signed, so a sibling cannot forge one; but it can sign
  // in with its own Google account, keep the cookie /login gave it, and set
  // that cookie on the victim's browser with a Domain attribute. The callback
  // would then take the attacker's state and code as the victim's own sign-in.
  async function startFlow() {
    const res = await get("/login");
    const flowCookie = res.headers.get("Set-Cookie")!.split(";")[0];
    const state = new URL(res.headers.get("Location")!).searchParams.get("state")!;
    return { flowCookie, state };
  }

  it("takes one flow cookie and no more", async () => {
    const mine = await startFlow();
    const theirs = await startFlow();
    const single = await get(`/oauth2/callback?state=${mine.state}&code=x`, { Cookie: mine.flowCookie });
    // Past the state check: it went on to Google, which the stub fails.
    expect(single.status).toBe(502);
    expect(fetched).toEqual(["https://oauth2.googleapis.com/token"]);

    fetched = [];
    for (const state of [mine.state, theirs.state]) {
      const both = await get(`/oauth2/callback?state=${state}&code=x`, { Cookie: `${mine.flowCookie}; ${theirs.flowCookie}` });
      expect(both.status).toBe(400);
    }
    expect(fetched).toEqual([]);
  });
});

describe("crossSiteGuard on a route nobody has written yet", () => {
  // A stand-in for a route added later without its own sameOrigin() call.
  const future = new Hono<AppEnv>();
  future.use("*", async (c, next) => {
    c.set("authKind", c.req.header("X-Test-Auth") === "device" ? "device" : c.req.header("Cookie") ? "session" : null);
    return next();
  });
  future.use("*", crossSiteGuard);
  const ran: string[] = [];
  for (const m of ["post", "put", "patch", "delete"] as const) {
    future[m]("/future", (c) => {
      ran.push(m);
      return c.text("changed");
    });
  }
  future.get("/future", (c) => c.text("read"));

  const call = (method: string, headers: Headers_) =>
    future.fetch(new Request(ORIGIN + "/future", { method, headers }), env as never);

  it("stops POST, PUT, PATCH and DELETE from another site before the handler runs", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const [who, headers] of ATTACKS) {
        const res = await call(method, { Cookie: "s=1", ...headers });
        expect(res.status, `${method} from ${who}`).toBe(403);
      }
    }
    expect(ran).toEqual([]);
  });

  it("lets this site's own request, a bearer, and any read through", async () => {
    expect((await call("POST", { Cookie: "s=1", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await call("DELETE", { Cookie: "s=1", Referer: ORIGIN + "/" })).status).toBe(200);
    expect((await call("POST", { "X-Test-Auth": "device" })).status).toBe(200);
    expect((await call("GET", { Cookie: "s=1", Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" })).status).toBe(200);
  });
});
