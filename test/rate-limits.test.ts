import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import worker from "../src/index";
import { AUTH_SEGMENT } from "../src/panel-host";
import { LIMITS, type Limit } from "../src/limits";
import { deleteAccountData } from "../src/db";
import { claimDevice, get, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

/**
 * The limits added by the rate-limit audit (docs/rate-limits.md). Each test
 * fills one bucket to its limit, proves the next request is refused, and
 * proves a different client (another address, account or device) is not.
 * The older limits are exercised in security.test.ts.
 */

/** Fill a bucket to its limit, in this window and the next (see security.test.ts). */
async function fill(bucket: string, rule: Limit) {
  const start = Math.floor(Date.now() / 1000 / rule.window) * rule.window;
  for (const w of [start, start + rule.window]) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET count = excluded.count",
    )
      .bind(bucket, w, rule.limit)
      .run();
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function refused(res: Response) {
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
}

describe("a bearer that names no device token", () => {
  it("is limited per address, counting failures only", async () => {
    const ip = "198.51.100.101";
    const mine = await claimDevice("badtoken@example.com");
    await fill(`bad-token:${ip}`, LIMITS.badToken);
    await refused(await get("/me", { ...bearer("syd_notatoken"), "CF-Connecting-IP": ip }));
    // A spoofed forwarding header does not buy a fresh bucket.
    await refused(await get("/me", { ...bearer("syd_notatoken"), "CF-Connecting-IP": ip, "X-Forwarded-For": "192.0.2.77" }));
    // A live token from the same address is never counted, so never refused.
    expect((await get("/me", { ...bearer(mine.token), "CF-Connecting-IP": ip })).status).toBe(200);
    // Another address is untouched.
    expect((await get("/me", { ...bearer("syd_notatoken"), "CF-Connecting-IP": "198.51.100.102" })).status).toBe(401);
  });

  it("is limited per IPv6 /64, not per full address", async () => {
    await fill("bad-token:2001:db8:1:2::/64", LIMITS.badToken);
    await refused(await get("/me", { ...bearer("syd_x"), "CF-Connecting-IP": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    expect((await get("/me", { ...bearer("syd_x"), "CF-Connecting-IP": "2001:db8:1:3::1" })).status).toBe(401);
  });
});

describe("the floor under every signed-in route", () => {
  it("limits a device token per device, whatever the route", async () => {
    const a = await claimDevice("floor-a@example.com");
    const b = await claimDevice("floor-b@example.com");
    await fill(`device-req:${a.deviceId}`, LIMITS.deviceRequests);
    for (const path of ["/me", "/drive/status", "/proxy/usage", "/settings/schedule"]) {
      await refused(await get(path, bearer(a.token)));
    }
    expect((await get("/me", bearer(b.token))).status).toBe(200);
  });

  it("limits a session cookie per account, but leaves the relayed panel to its own limit", async () => {
    const a = await signedInAs("floor-c@example.com");
    const b = await signedInAs("floor-d@example.com");
    await fill(`session-req:${a.account.id}`, LIMITS.sessionRequests);
    await refused(await get("/", { Cookie: a.cookie }));
    await refused(await get("/me", { Cookie: a.cookie }));
    expect((await get("/", { Cookie: b.cookie })).status).toBe(200);
    // /p/ is not counted here: this is a 404 for an unknown device, not a 429.
    expect((await get("/p/nosuchdevice/api/x", { Cookie: a.cookie })).status).toBe(404);
  });
});

describe("/relay/connect", () => {
  it("is limited per device", async () => {
    const a = await claimDevice("connect-a@example.com");
    const b = await claimDevice("connect-b@example.com");
    await fill(`relay-connect:${a.deviceId}`, LIMITS.relayConnect);
    const ws = { Upgrade: "websocket" };
    await refused(await get("/relay/connect", { ...ws, ...bearer(a.token) }));
    // Another device is not refused: no socket is opened here, so the plain GET reaches the upgrade check.
    expect((await get("/relay/connect", bearer(b.token))).status).toBe(426);
  });
});

describe("the relayed panel", () => {
  it("is limited per viewing account, as a page and as an API", async () => {
    const mine = await claimDevice("view-a@example.com");
    const other = await claimDevice("view-b@example.com");
    await fill(`relay-view:${mine.account.id}`, LIMITS.relayView);
    const page = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    await refused(page);
    expect(await page.text()).toContain("Too many tries");
    const api = await get(`/p/${mine.deviceId}/api/state`, { Cookie: mine.cookie });
    await refused(api);
    expect(((await api.json()) as { error: string }).error).toBe("rate_limited");
    // Another account is not held back by it (it is told the panel is not its own instead).
    expect((await get(`/p/${mine.deviceId}/api/state`, { Cookie: other.cookie })).status).toBe(403);
  });

  it("is limited on the panel host too, on the same bucket", async () => {
    const mine = await claimDevice("view-c@example.com");
    const PANEL = "https://panels.example";
    const call = (url: string, init: RequestInit = {}) =>
      worker.fetch(new Request(url, { redirect: "manual", ...init }), { ...(env as unknown as Bindings), PANEL_ORIGIN: PANEL }, createExecutionContext());
    // A panel cookie by way of the ticket, the way a browser comes by one.
    const handed = await call(`${ORIGIN}/p/${mine.deviceId}/`, { headers: { Cookie: mine.cookie } });
    const auth = await call(handed.headers.get("Location")!);
    const panelCookie = auth.headers.get("Set-Cookie")!.split(";")[0];
    await fill(`relay-view:${mine.account.id}`, LIMITS.relayView);
    await refused(await call(`${PANEL}/p/${mine.deviceId}/api/state`, { headers: { Cookie: panelCookie } }));
  });
});

describe("the panel ticket exchange", () => {
  it("is limited per address on the panel host", async () => {
    const PANEL = "https://panels.example";
    const at = (ip: string) =>
      worker.fetch(
        new Request(`${PANEL}/p/somedevice/${AUTH_SEGMENT}?t=junk`, { headers: { "CF-Connecting-IP": ip }, redirect: "manual" }),
        { ...(env as unknown as Bindings), PANEL_ORIGIN: PANEL },
        createExecutionContext(),
      );
    await fill("panel-ticket:198.51.100.110", LIMITS.panelTicket);
    await refused(await at("198.51.100.110"));
    expect((await at("198.51.100.111")).status).toBe(403);
  });
});

describe("POST /drive/token", () => {
  it("is limited per account, before it asks Google anything", async () => {
    const a = await claimDevice("drive-a@example.com");
    const b = await claimDevice("drive-b@example.com");
    await fill(`drive-token:${a.account.id}`, LIMITS.driveToken);
    await refused(await postJson("/drive/token", {}, bearer(a.token)));
    // Not refused: this account simply has no grant.
    expect((await postJson("/drive/token", {}, bearer(b.token))).status).toBe(404);
  });
});

describe("PUT /settings/:name", () => {
  const put = (token: string) =>
    SELF.fetch(ORIGIN + "/settings/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.200", ...bearer(token) },
      body: JSON.stringify({ content: "x" }),
    });

  it("is limited per account, and reading is not", async () => {
    const a = await claimDevice("set-a@example.com");
    const b = await claimDevice("set-b@example.com");
    await fill(`settings-write:${a.account.id}`, LIMITS.settingsWrite);
    await refused(await put(a.token));
    expect((await get("/settings/schedule", bearer(a.token))).status).toBe(404);
    expect((await put(b.token)).status).toBe(200);
  });
});

describe("POST /account/delete", () => {
  it("is limited per account, before it calls Stripe", async () => {
    const a = await signedInAs("del-a@example.com");
    const b = await signedInAs("del-b@example.com");
    // A wrong confirmation is a 400 and touches nothing; it is what gets counted.
    expect((await postForm("/account/delete", { confirm_email: "nope" }, { Cookie: a.cookie })).status).toBe(400);
    await fill(`account-delete:${a.account.id}`, LIMITS.accountDelete);
    await refused(await postForm("/account/delete", { confirm_email: "del-a@example.com" }, { Cookie: a.cookie }));
    expect((await postForm("/account/delete", { confirm_email: "nope" }, { Cookie: b.cookie })).status).toBe(400);
  });
});

describe("deleting an account", () => {
  it("clears the counters kept under its account and device ids, and nobody else's", async () => {
    const gone = await claimDevice("erase-a@example.com");
    const kept = await claimDevice("erase-b@example.com");
    for (const who of [gone, kept]) await get("/me", bearer(who.token));
    await get("/", { Cookie: gone.cookie });
    const buckets = async (id: string) =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE ?").bind(`%${id}`).first<{ n: number }>())!.n;
    expect(await buckets(gone.deviceId)).toBeGreaterThan(0);
    expect(await buckets(gone.account.id)).toBeGreaterThan(0);
    await deleteAccountData(env.DB, gone.account.id, "hash");
    expect(await buckets(gone.deviceId)).toBe(0);
    expect(await buckets(gone.account.id)).toBe(0);
    expect(await buckets(kept.deviceId)).toBeGreaterThan(0);
  });
});
