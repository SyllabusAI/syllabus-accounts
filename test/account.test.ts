import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../src/crypto";
import * as db from "../src/db";
import type { WelcomeFrame } from "../src/panel-relay";
import { claimDevice, get, grant, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { method: string; url: string };

/**
 * Stripe and Google, scripted. `subs` is what Stripe says each customer holds;
 * `failCancel` makes every cancellation fail the way a Stripe error does.
 */
function outside(opts: { subs?: Record<string, { id: string; status: string }[]>; failCancel?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      calls.push({ method, url });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
      const u = new URL(url);
      if (u.hostname === "api.stripe.com" && u.pathname === "/v1/subscriptions" && method === "GET") {
        const customer = u.searchParams.get("customer") ?? "";
        const data = (opts.subs?.[customer] ?? []).map((s) => ({ object: "subscription", customer, ...s }));
        return json(200, { object: "list", data, has_more: false, url: "/v1/subscriptions" });
      }
      const cancel = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
      if (u.hostname === "api.stripe.com" && cancel && method === "DELETE") {
        if (opts.failCancel) {
          return json(400, { error: { type: "invalid_request_error", message: "Stripe says no" } });
        }
        if (cancel[1] === "sub_gone") {
          return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such subscription" } });
        }
        return json(200, { id: cancel[1], object: "subscription", status: "canceled" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

const cancels = (calls: Call[]) =>
  calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname.split("/").pop());

/** An account with a row in every table that can hold one. */
async function fullAccount(email: string) {
  const mine = await claimDevice(email, "Desk Mac");
  const id = mine.account.id;
  await db.putSetting(env.DB, id, "syllabus", "schedule", "[[class]]\nname = 'ACCT'", mine.deviceId, null);
  await db.putDriveGrant(env.DB, id, await encrypt(env.DRIVE_KEY, "1//refresh-to-revoke"), "drive.file", email);
  await db.recordUsage(env.DB, id, mine.deviceId, "transcribe", 1200, "groq");
  await db.putAllowance(env.DB, id, grant(162_000, 1_350_000, "pro"));
  await db.recordTopup(env.DB, `cs_topup_${id}`, id, 18_000, 150_000);
  await db.linkStripeCustomer(env.DB, `cus_${id}`, id);
  await db.putSubscription(env.DB, {
    stripe_subscription_id: `sub_${id}`,
    account_id: id,
    stripe_customer_id: `cus_${id}`,
    price_id: "price_test_pro",
    tier: "pro",
    status: "active",
    current_period_end: "",
    cancel_at_period_end: 0,
  });
  await db.hitRateLimit(env.DB, `transcribe:${id}`, 20, 60);
  await db.hitRateLimit(env.DB, `trial-end:${id}`, 1, 300);
  await db.claimStripeEvent(env.DB, `evt_${id}`, "checkout.session.completed", id);
  return mine;
}

/** Every table with a column naming an account, and how many rows still name this one. */
async function rowsNaming(accountId: string, deviceIds: string[]) {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  ).all<{ name: string }>();
  const left: Record<string, number> = {};
  let checked = 0;
  for (const { name } of tables.results) {
    const cols = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
    const names = cols.results.map((c) => c.name);
    const where: string[] = [];
    const binds: string[] = [];
    for (const col of ["account_id", "approved_account_id"]) {
      if (names.includes(col)) {
        where.push(`${col} = ?`);
        binds.push(accountId);
      }
    }
    if (name === "accounts") {
      where.push("id = ?");
      binds.push(accountId);
    }
    for (const col of ["device_id", "approved_device_id"]) {
      if (names.includes(col) && deviceIds.length) {
        where.push(`${col} IN (${deviceIds.map(() => "?").join(", ")})`);
        binds.push(...deviceIds);
      }
    }
    if (name === "devices" && deviceIds.length) {
      where.push(`id IN (${deviceIds.map(() => "?").join(", ")})`);
      binds.push(...deviceIds);
    }
    if (name === "rate_limits") {
      where.push("substr(bucket, -length(?) - 1) = ':' || ?");
      binds.push(accountId, accountId);
    }
    if (!where.length) continue;
    checked += 1;
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE ${where.join(" OR ")}`)
      .bind(...binds)
      .first<{ n: number }>();
    if (row!.n) left[name] = row!.n;
  }
  return { left, checked };
}

function confirm(cookie: string, email: string, headers: Record<string, string> = {}) {
  return postForm("/account/delete", { confirm_email: email }, { Cookie: cookie, ...headers });
}

describe("the account page", () => {
  it("offers deletion in its own section, behind a confirmation page", async () => {
    const { cookie } = await signedInAs("page@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Delete your account");
    expect(html).toContain('href="/account/delete"');
    // The account page itself carries no form that deletes.
    expect(html).not.toContain('action="/account/delete"');

    const page = await get("/account/delete", { Cookie: cookie });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('action="/account/delete"');
    expect(text).toContain("page@example.com");
    expect(text).toContain("cannot be undone");
    expect(text).not.toContain("\u2014");
  });

  it("says what a fuller account loses", async () => {
    const mine = await fullAccount("fuller@example.com");
    const text = await (await get("/account/delete", { Cookie: mine.cookie })).text();
    expect(text).toContain("Your plan is canceled right away");
    expect(text).toContain("Your Mac is signed out");
    expect(text).toContain("Google Drive connection is revoked");
  });
});

describe("who may delete", () => {
  it("needs a signed-in person", async () => {
    const page = await get("/account/delete");
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toContain("/login");
    const res = await postForm("/account/delete", { confirm_email: "nobody@example.com" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/login");
  });

  it("refuses a panel's device token", async () => {
    const mine = await claimDevice("panel-deleter@example.com");
    const res = await SELF.fetch(ORIGIN + "/account/delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mine.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: new URLSearchParams({ confirm_email: "panel-deleter@example.com" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await db.accountById(env.DB, mine.account.id)).not.toBeNull();
    expect((await get("/account/delete", { Authorization: `Bearer ${mine.token}` })).status).toBe(403);
  });

  it("refuses a post from another site", async () => {
    const { account, cookie } = await signedInAs("cross@example.com");
    const res = await confirm(cookie, "cross@example.com", { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await db.accountById(env.DB, account.id)).not.toBeNull();
  });

  it("needs the email typed, and the right one", async () => {
    const { account, cookie } = await signedInAs("typed@example.com");
    let res = await confirm(cookie, "");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Nothing was deleted");
    res = await confirm(cookie, "someone-else@example.com");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not match");
    expect(await db.accountById(env.DB, account.id)).not.toBeNull();
    // Case and stray spaces are not a reason to refuse.
    res = await confirm(cookie, "  Typed@Example.com ");
    expect(res.status).toBe(200);
    expect(await db.accountById(env.DB, account.id)).toBeNull();
  });
});

describe("deleting", () => {
  it("removes every row that names the account or its Macs, and keeps the Stripe event id", async () => {
    const mine = await fullAccount("everything@example.com");
    const bystander = await fullAccount("bystander@example.com");
    const deviceIds = await db.allDeviceIdsOf(env.DB, mine.account.id);
    const before = await rowsNaming(mine.account.id, deviceIds);
    // The fixture has to reach every table the check can see, or the check proves little.
    expect(Object.keys(before.left).sort()).toEqual(
      [
        "accounts", "allowances", "device_codes", "device_tokens", "devices", "drive_grants", "rate_limits",
        "settings", "stripe_customers", "stripe_events", "subscriptions", "topups", "usage",
      ].sort(),
    );

    const calls = outside({ subs: { [`cus_${mine.account.id}`]: [{ id: `sub_${mine.account.id}`, status: "active" }] } });
    const res = await confirm(mine.cookie, "everything@example.com");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your account is deleted");

    const after = await rowsNaming(mine.account.id, deviceIds);
    expect(after.left).toEqual({});
    expect(after.checked).toBe(before.checked);

    // The idempotency row survives, with nothing pointing back at the person.
    const event = await env.DB.prepare("SELECT account_id FROM stripe_events WHERE id = ?")
      .bind(`evt_${mine.account.id}`)
      .first<{ account_id: string }>();
    expect(event).toEqual({ account_id: "" });

    // The other account is untouched.
    const theirs = await rowsNaming(bystander.account.id, await db.allDeviceIdsOf(env.DB, bystander.account.id));
    expect(Object.keys(theirs.left).sort()).toEqual(Object.keys(before.left).sort());

    // Drive was revoked at Google with the stored token.
    expect(calls.some((c) => c.url.includes("oauth2.googleapis.com/revoke?token=1%2F%2Frefresh-to-revoke"))).toBe(true);
  });

  it("cancels the live subscription at Stripe, including one only Stripe knows about", async () => {
    const mine = await fullAccount("paying@example.com");
    const cus = `cus_${mine.account.id}`;
    const calls = outside({
      subs: {
        [cus]: [
          { id: `sub_${mine.account.id}`, status: "active" },
          // Its created event never arrived, so the mirror has no row for it.
          { id: "sub_unmirrored", status: "trialing" },
          { id: "sub_old", status: "canceled" },
        ],
      },
    });
    const res = await confirm(mine.cookie, "paying@example.com");
    expect(res.status).toBe(200);
    expect(cancels(calls).sort()).toEqual([`sub_${mine.account.id}`, "sub_unmirrored"].sort());
    expect(calls.some((c) => c.method === "GET" && c.url.includes(`customer=${cus}`))).toBe(true);
  });

  it("treats a subscription Stripe no longer has as already canceled", async () => {
    const { account, cookie } = await signedInAs("gone-sub@example.com");
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_gone",
      account_id: account.id,
      stripe_customer_id: "",
      price_id: "price_test_starter",
      tier: "starter",
      status: "active",
      current_period_end: "",
      cancel_at_period_end: 0,
    });
    const calls = outside();
    const res = await confirm(cookie, "gone-sub@example.com");
    expect(res.status).toBe(200);
    expect(cancels(calls)).toEqual(["sub_gone"]);
    expect(await db.accountById(env.DB, account.id)).toBeNull();
  });

  it("deletes nothing when Stripe will not cancel, and says so", async () => {
    const mine = await fullAccount("stuck@example.com");
    const deviceIds = await db.allDeviceIdsOf(env.DB, mine.account.id);
    const before = await rowsNaming(mine.account.id, deviceIds);
    const calls = outside({
      subs: { [`cus_${mine.account.id}`]: [{ id: `sub_${mine.account.id}`, status: "active" }] },
      failCancel: true,
    });
    const res = await confirm(mine.cookie, "stuck@example.com");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("nothing was deleted");
    expect((await rowsNaming(mine.account.id, deviceIds)).left).toEqual(before.left);
    // Stripe came first: Google was not asked to revoke anything.
    expect(calls.some((c) => c.url.includes("oauth2.googleapis.com"))).toBe(false);
    expect((await get("/me", { Authorization: `Bearer ${mine.token}` })).status).toBe(200);
  });

  it("makes no Stripe call for an account that never reached Checkout", async () => {
    const { account, cookie } = await signedInAs("free@example.com");
    const calls = outside();
    expect((await confirm(cookie, "free@example.com")).status).toBe(200);
    expect(calls).toEqual([]);
    expect(await db.accountById(env.DB, account.id)).toBeNull();
  });

  it("ends every device token, and signs the browser out", async () => {
    const mine = await claimDevice("tokens@example.com", "Laptop");
    const second = await claimDevice("tokens@example.com", "Desktop");
    expect((await get("/me", { Authorization: `Bearer ${mine.token}` })).status).toBe(200);

    const res = await confirm(mine.cookie, "tokens@example.com");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("syllabus_accounts_session=;");
    expect(setCookie).toMatch(/Max-Age=0/i);

    for (const token of [mine.token, second.token]) {
      expect((await get("/me", { Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await postJson("/drive/token", {}, { Authorization: `Bearer ${token}` })).status).toBe(401);
    }
    // A cookie kept from before names nobody now.
    expect((await get("/me", { Cookie: mine.cookie })).status).toBe(401);
    expect(await (await get("/", { Cookie: mine.cookie })).text()).toContain("Sign in with Google");
  });

  it("is harmless to post twice", async () => {
    const { account, cookie } = await signedInAs("twice@example.com");
    expect((await confirm(cookie, "twice@example.com")).status).toBe(200);
    const again = await confirm(cookie, "twice@example.com");
    expect(again.status).toBe(302);
    expect(again.headers.get("Location")).toContain("/login");
    expect(await db.accountById(env.DB, account.id)).toBeNull();
  });

  it("drops a connected panel's socket and forgets the Mac", async () => {
    const mine = await claimDevice("socket@example.com", "Studio Mac");
    const res = await SELF.fetch(ORIGIN + "/relay/connect", {
      headers: { Upgrade: "websocket", Authorization: "Bearer " + mine.token },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const welcome = new Promise<WelcomeFrame>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data)) as WelcomeFrame)),
    );
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    expect((await welcome).device).toBe(mine.deviceId);

    expect((await confirm(mine.cookie, "socket@example.com")).status).toBe(200);
    expect(await closed).toBe(4001);
    try {
      ws.close();
    } catch {
      /* already closed */
    }

    const stub = env.PANEL.get(env.PANEL.idFromName(mine.deviceId));
    const state = (await (await stub.fetch("https://panel-relay/", { headers: { "X-Relay-Op": "state" } })).json()) as {
      name: string;
      connected: boolean;
      connected_at: string;
    };
    expect(state.connected).toBe(false);
    expect(state.name).toBe("");
    expect(state.connected_at).toBe("");

    // The panel's reconnect is refused: its token is gone.
    const retry = await SELF.fetch(ORIGIN + "/relay/connect", {
      headers: { Upgrade: "websocket", Authorization: "Bearer " + mine.token },
    });
    expect(retry.status).toBe(401);
  });
});

describe("afterwards", () => {
  it("signing in again with the same Google account starts a new, empty account", async () => {
    const mine = await fullAccount("again@example.com");
    outside({ subs: {} });
    expect((await confirm(mine.cookie, "again@example.com")).status).toBe(200);
    vi.unstubAllGlobals();

    const fresh = await signedInAs("again@example.com", mine.account.google_sub);
    expect(fresh.account.id).not.toBe(mine.account.id);
    expect(await db.devicesOf(env.DB, fresh.account.id)).toEqual([]);
    expect(await db.allowance(env.DB, fresh.account.id)).toBeNull();
    expect(await db.driveGrant(env.DB, fresh.account.id)).toBeNull();
    expect(await db.stripeCustomerOf(env.DB, fresh.account.id)).toBeNull();
    const html = await (await get("/", { Cookie: fresh.cookie })).text();
    expect(html).toContain("again@example.com");
    expect(html).toContain("No Macs yet");
  });

  it("leaves no customer link behind for the webhook to find", async () => {
    // What the webhook then does with an event naming the deleted account is
    // in test/stripe.test.ts.
    const mine = await fullAccount("webhook-after@example.com");
    outside({ subs: {} });
    expect((await confirm(mine.cookie, "webhook-after@example.com")).status).toBe(200);
    expect(await db.accountIdForLinkedCustomer(env.DB, `cus_${mine.account.id}`)).toBeNull();
    expect(await db.accountIdForCustomer(env.DB, `cus_${mine.account.id}`)).toBeNull();
  });
});
