import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { TIERS, type TierName } from "../src/tiers";
import { claimDevice, get, postForm, signedInAs } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY = 24 * 3600;
/** Ten days into a thirty-day billing period. */
const PERIOD_START = Math.floor(Date.now() / 1000) - 10 * DAY;
const PERIOD_END = PERIOD_START + 30 * DAY;

function priceOf(tier: TierName): string {
  return { starter: env.STRIPE_PRICE_STARTER, standard: env.STRIPE_PRICE_STANDARD, pro: env.STRIPE_PRICE_PRO }[tier];
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** A subscription as GET /v1/subscriptions/:id returns it. */
function stripeSub(id: string, price: string, over: Record<string, unknown> = {}) {
  return {
    id,
    object: "subscription",
    status: "active",
    cancel_at_period_end: false,
    customer: "cus_up",
    items: {
      object: "list",
      data: [
        {
          id: `si_${id}`,
          object: "subscription_item",
          price: { id: price, object: "price" },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...over,
  };
}

type Seen = { method: string; path: string; body: URLSearchParams; idempotencyKey: string | null };

/**
 * Stripe, scripted. `live` is what it says the subscription is; `update`
 * answers the change. Anything else is a bug in the route and fails the test.
 */
function stripe(live: Record<string, unknown>, update: () => Response = () => json(200, live)) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = String(init.method ?? "GET").toUpperCase();
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      seen.push({ method, path: url.pathname, body, idempotencyKey: new Headers(init.headers).get("Idempotency-Key") });
      if (url.pathname === `/v1/subscriptions/${live.id}` && method === "GET") return json(200, live);
      if (url.pathname === `/v1/subscriptions/${live.id}` && method === "POST") return update();
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return seen;
}

/** A signed-in account holding `tier`, mirrored as Stripe last described it. */
async function subscriber(email: string, tier: TierName, over: Partial<db.Subscription> = {}) {
  const { account, cookie } = await signedInAs(email);
  const id = `sub_${account.id}`;
  await db.linkStripeCustomer(env.DB, `cus_${account.id}`, account.id);
  await db.putAllowance(env.DB, account.id, {
    audio_seconds: TIERS[tier].audio_seconds,
    summary_tokens: TIERS[tier].summary_tokens,
    assistant_sessions: TIERS[tier].assistant_sessions,
    source: tier,
  });
  await db.putSubscription(env.DB, {
    stripe_subscription_id: id,
    account_id: account.id,
    stripe_customer_id: `cus_${account.id}`,
    price_id: priceOf(tier),
    tier,
    status: "active",
    current_period_end: new Date(PERIOD_END * 1000).toISOString(),
    cancel_at_period_end: 0,
    ...over,
  });
  return { account, cookie, id };
}

const page = async (cookie: string) => (await get("/", { Cookie: cookie })).text();

describe("what the account page offers", () => {
  it("offers both bigger plans to Starter, and no way down", async () => {
    const { cookie } = await subscriber("page-up-starter@example.com", "starter");
    const html = await page(cookie);
    expect(html).toContain("Upgrade to Standard");
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain('action="/billing/upgrade"');
    expect(html).not.toContain("Want a smaller plan?");
  });

  it("offers Pro to Standard, and says how to move down", async () => {
    const { cookie } = await subscriber("page-up-standard@example.com", "standard");
    const html = await page(cookie);
    expect(html).toContain("Upgrade to Pro");
    expect(html).not.toContain("Upgrade to Standard");
    expect(html).toContain("Want a smaller plan? Cancel under Manage billing");
  });

  it("offers nothing bigger to Pro", async () => {
    const { cookie } = await subscriber("page-up-pro@example.com", "pro");
    expect(await page(cookie)).not.toContain("Upgrade to");
  });

  it("offers nothing on a plan set to end, or one still in its trial", async () => {
    const ending = await subscriber("page-up-ending@example.com", "starter", { cancel_at_period_end: 1 });
    expect(await page(ending.cookie)).not.toContain("Upgrade to");
    const trying = await subscriber("page-up-trial@example.com", "starter", { status: "trialing" });
    expect(await page(trying.cookie)).not.toContain("Upgrade to");
  });

  it("points a subscriber who has run out at the bigger plans", async () => {
    const { account, cookie, deviceId } = await claimDevice("page-up-capped@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds,
      summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0,
      source: "starter",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_page_up_capped",
      account_id: account.id,
      stripe_customer_id: "cus_page_up_capped",
      price_id: env.STRIPE_PRICE_STARTER,
      tier: "starter",
      status: "active",
      current_period_end: new Date(PERIOD_END * 1000).toISOString(),
      cancel_at_period_end: 0,
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TIERS.starter.audio_seconds);
    const html = await page(cookie);
    expect(html).toContain("Recording is stopped until the month turns over or you upgrade below");
    expect(html).toContain("Need more hours this month?");
    expect(html).toContain('<button class="primary">Upgrade to Pro</button>');
  });

  it("says the bigger plan is on its way after the upgrade", async () => {
    const { cookie } = await subscriber("page-up-notice@example.com", "starter");
    const html = await (await get("/?billing=upgraded", { Cookie: cookie })).text();
    expect(html).toContain("Stripe is moving you to the bigger plan");
  });
});

describe("POST /billing/upgrade", () => {
  it("shows the price, and charges nothing, until it is confirmed", async () => {
    const { cookie, id } = await subscriber("up-confirm@example.com", "starter");
    const seen = stripe(stripeSub(id, env.STRIPE_PRICE_STARTER));
    const res = await postForm("/billing/upgrade", { tier: "pro" }, { Cookie: cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain("<strong>$16 now</strong>, plus any sales tax");
    expect(html).toContain("This month's hours go up to 45");
    expect(html).toContain("Upgrade and pay $16");
    expect(html).toContain('name="confirm" value="1"');
    expect(seen).toEqual([]);
  });

  it("charges the whole difference now, once confirmed, and refuses an unpaid change", async () => {
    const { account, cookie, id } = await subscriber("up-charge@example.com", "starter");
    const seen = stripe(stripeSub(id, env.STRIPE_PRICE_STARTER));
    const res = await postForm("/billing/upgrade", { tier: "pro", confirm: "1" }, { Cookie: cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/?billing=upgraded");

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/subscriptions/${id}`, `POST /v1/subscriptions/${id}`]);
    const change = seen[1];
    expect(change.body.get("items[0][id]")).toBe(`si_${id}`);
    expect(change.body.get("items[0][price]")).toBe(env.STRIPE_PRICE_PRO);
    // Prorated as though made at the start of the period: the full difference.
    expect(change.body.get("proration_behavior")).toBe("always_invoice");
    expect(change.body.get("proration_date")).toBe(String(PERIOD_START));
    // A card that does not pay leaves the plan as it was.
    expect(change.body.get("payment_behavior")).toBe("error_if_incomplete");
    expect(change.idempotencyKey).toBe(`upgrade:${id}:${PERIOD_START}:${env.STRIPE_PRICE_PRO}`);

    // Nothing is granted here. The webhook does that when Stripe confirms.
    expect((await db.allowance(env.DB, account.id))?.source).toBe("starter");
  });

  it("only goes up", async () => {
    const starter = await subscriber("up-sideways@example.com", "starter");
    const pro = await subscriber("up-down@example.com", "pro");
    const seen = stripe(stripeSub(starter.id, env.STRIPE_PRICE_STARTER));
    for (const [cookie, tier] of [
      [starter.cookie, "starter"],
      [pro.cookie, "standard"],
      [pro.cookie, "starter"],
    ]) {
      const res = await postForm("/billing/upgrade", { tier, confirm: "1" }, { Cookie: cookie });
      expect(await res.text()).toContain("That plan is not bigger than the one you have. Nothing was charged.");
    }
    expect(seen).toEqual([]);
  });

  it("refuses a plan that is ending, still in its trial, or not there", async () => {
    const ending = await subscriber("up-ending@example.com", "starter", { cancel_at_period_end: 1 });
    const trying = await subscriber("up-trying@example.com", "starter", { status: "trialing" });
    const nobody = await signedInAs("up-nobody@example.com");
    const seen = stripe(stripeSub(ending.id, env.STRIPE_PRICE_STARTER));
    for (const cookie of [ending.cookie, trying.cookie, nobody.cookie]) {
      const res = await postForm("/billing/upgrade", { tier: "pro", confirm: "1" }, { Cookie: cookie });
      expect(await res.text()).toContain("Only a plan that is active and renewing can be upgraded. Nothing was charged.");
    }
    expect(seen).toEqual([]);
  });

  it("takes only a plan we sell", async () => {
    const { cookie } = await subscriber("up-unknown@example.com", "starter");
    const seen = stripe({ id: "sub_none" });
    const res = await postForm("/billing/upgrade", { tier: "enterprise", confirm: "1" }, { Cookie: cookie });
    expect(await res.text()).toContain("That is not a plan we sell.");
    expect(seen).toEqual([]);
  });

  it("changes nothing when Stripe's plan is not the one the page showed", async () => {
    // The mirror says Starter; Stripe already has Pro, a webhook behind.
    const { cookie, id } = await subscriber("up-stale@example.com", "starter");
    const seen = stripe(stripeSub(id, env.STRIPE_PRICE_PRO));
    const res = await postForm("/billing/upgrade", { tier: "pro", confirm: "1" }, { Cookie: cookie });
    expect(await res.text()).toContain("Your plan changed while this page was open, so nothing was charged.");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("changes nothing when Stripe has the plan ending", async () => {
    const { cookie, id } = await subscriber("up-stale-ending@example.com", "starter");
    const seen = stripe(stripeSub(id, env.STRIPE_PRICE_STARTER, { cancel_at_period_end: true }));
    const res = await postForm("/billing/upgrade", { tier: "standard", confirm: "1" }, { Cookie: cookie });
    expect(await res.text()).toContain("Your plan changed while this page was open");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("says so when the card is declined, and the plan stays as it was", async () => {
    const { account, cookie, id } = await subscriber("up-declined@example.com", "standard");
    stripe(stripeSub(id, env.STRIPE_PRICE_STANDARD), () =>
      json(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }),
    );
    const res = await postForm("/billing/upgrade", { tier: "pro", confirm: "1" }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your card was declined, so your plan has not changed and nothing was charged.");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("standard");
  });

  it("says nothing changed when Stripe fails for any other reason", async () => {
    const { cookie, id } = await subscriber("up-stripe-down@example.com", "starter");
    stripe(stripeSub(id, env.STRIPE_PRICE_STARTER), () =>
      json(500, { error: { type: "api_error", message: "Something went wrong on Stripe's end." } }),
    );
    const res = await postForm("/billing/upgrade", { tier: "standard", confirm: "1" }, { Cookie: cookie });
    expect(await res.text()).toContain("Stripe could not make that change. Your plan has not changed and nothing was charged.");
  });
});

describe("what the terms promise", () => {
  it("describes upgrading the way the route charges it, and sells nothing on top of a plan", async () => {
    const html = await (await get("/terms")).text();
    expect(html).toContain("We charge the difference");
    expect(html).toContain("including any upgrade you paid for that month");
    expect(html).not.toContain("Extra hours");
    expect(html).not.toContain("add hours");
  });
});
