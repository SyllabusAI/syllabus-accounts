import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { TIERS, TRIAL_ALLOWANCE } from "../src/tiers";
import { claimDevice, get, ORIGIN, postForm, signedInAs } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(answer: (url: string, body: URLSearchParams, init: RequestInit) => Response) {
  const seen: { url: string; body: URLSearchParams; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      seen.push({ url, body, method: String(init.method ?? "GET") });
      return answer(url, body, init);
    }),
  );
  return seen;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function sign(payload: string, at = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("whsec_test_secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${at},v1=${hex}`;
}

async function deliver(event: unknown) {
  const raw = JSON.stringify(event);
  return SELF.fetch(ORIGIN + "/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": await sign(raw) },
    body: raw,
  });
}

let n = 0;
const nextId = () => `evt_t${++n}_${Math.random().toString(36).slice(2, 7)}`;

describe("the trial is 5 hours, with a card behind it", () => {
  it("asks for a card and sets a long Stripe trial", async () => {
    const { cookie } = await signedInAs("trialist@example.com");
    const sent = calls(() => json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    await postForm("/billing/checkout", { tier: "standard" }, { Cookie: cookie });
    const body = sent[0].body;
    // A trial owes nothing today, so Stripe only collects a card when told to
    // always collect one.
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("subscription_data[trial_period_days]")).toBe("7");
  });

  it("gives a trialing subscription the 5 hours, not the plan", async () => {
    const { account, token } = await claimDevice("in-trial@example.com");
    await db.linkStripeCustomer(env.DB, "cus_intrial", account.id);
    await deliver({
      id: nextId(),
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_intrial", object: "subscription", customer: "cus_intrial", status: "trialing",
          cancel_at_period_end: false, metadata: {},
          items: { data: [{ id: "si_1", price: { id: "price_test_pro" }, current_period_end: Math.floor(Date.now() / 1000) + 90 * 86400 }] },
        },
      },
    });

    const row = await db.allowance(env.DB, account.id);
    expect(row).toMatchObject({ audio_seconds: TRIAL_ALLOWANCE.audio_seconds, source: "trial" });
    // Pro's 45 hours are not granted until the card is charged.
    expect(row?.audio_seconds).not.toBe(TIERS.pro.audio_seconds);

    const usage = (await (await get("/proxy/usage", bearer(token))).json()) as Record<string, any>;
    expect(usage.audio_seconds.allowance).toBe(5 * 3600);
  });

  it("gives the plan's hours the moment Stripe says the trial is over", async () => {
    const { account } = await signedInAs("converted@example.com");
    await db.linkStripeCustomer(env.DB, "cus_converted", account.id);
    const sub = (status: string) => ({
      id: nextId(),
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_converted", object: "subscription", customer: "cus_converted", status,
          cancel_at_period_end: false, metadata: {},
          items: { data: [{ id: "si_1", price: { id: "price_test_standard" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
        },
      },
    });
    await deliver(sub("trialing"));
    expect((await db.allowance(env.DB, account.id))?.audio_seconds).toBe(TRIAL_ALLOWANCE.audio_seconds);
    await deliver(sub("active"));
    expect(await db.allowance(env.DB, account.id)).toMatchObject({
      audio_seconds: TIERS.standard.audio_seconds,
      source: "standard",
    });
  });

  it("redeeming a code takes no trial and still asks for a card", async () => {
    const { cookie } = await signedInAs("coded@example.com");
    const sent = calls(() => json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    await postForm("/billing/checkout", { tier: "pro", redeem: "1" }, { Cookie: cookie });
    const body = sent[0].body;
    expect(body.get("payment_method_collection")).toBe("always");
    expect(body.get("subscription_data[trial_period_days]")).toBeNull();
    // Still a promotion code field, which is the whole point of this path.
    expect(body.get("allow_promotion_codes")).toBe("true");
  });
});

describe("spending the trial ends it", () => {
  /** An account mid-trial with `used` seconds already spent. */
  async function inTrial(email: string, used: number) {
    const claimed = await claimDevice(email);
    await db.putAllowance(env.DB, claimed.account.id, {
      audio_seconds: TRIAL_ALLOWANCE.audio_seconds,
      summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
      assistant_sessions: 0,
      source: "trial",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: `sub_${email.split("@")[0]}`,
      account_id: claimed.account.id,
      stripe_customer_id: `cus_${email}`,
      price_id: env.STRIPE_PRICE_STANDARD,
      tier: "standard",
      status: "trialing",
      current_period_end: new Date(Date.now() + 80 * 864e5).toISOString(),
      cancel_at_period_end: 0,
    });
    if (used > 0) await db.recordUsage(env.DB, claimed.account.id, claimed.deviceId, "transcribe", used);
    return claimed;
  }

  it("tells Stripe to end the trial now, once the hours are gone", async () => {
    const { account } = await inTrial("spent@example.com", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({ id: "sub_spent", status: "active" }));

    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain("/v1/subscriptions/sub_spent");
    expect(sent[0].body.get("trial_end")).toBe("now");
  });

  it("leaves a trial alone while there are hours left in it", async () => {
    const { account } = await inTrial("mid-trial@example.com", 3600);
    const sent = calls(() => json({}));
    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(0);
  });

  it("does not touch an account that never went through checkout", async () => {
    // No allowance row at all is the free trial, which has no card and no
    // subscription to end.
    const { account } = await claimDevice("no-checkout@example.com");
    await db.recordUsage(env.DB, account.id, "dev", "transcribe", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({}));
    const { endTrialIfSpent } = await import("../src/stripe");
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(0);
  });

  it("asks once, not once per chunk, while Stripe catches up", async () => {
    const { account } = await inTrial("chatty@example.com", TRIAL_ALLOWANCE.audio_seconds);
    const sent = calls(() => json({ status: "active" }));
    const { endTrialIfSpent } = await import("../src/stripe");
    // A lecture uploads as many chunks, and each one settles.
    await endTrialIfSpent(env, account.id);
    await endTrialIfSpent(env, account.id);
    await endTrialIfSpent(env, account.id);
    expect(sent).toHaveLength(1);
  });

  it("leaves the account where it is when Stripe will not answer", async () => {
    const { account } = await inTrial("stripe-down@example.com", TRIAL_ALLOWANCE.audio_seconds);
    calls(() => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }));
    const { endTrialIfSpent } = await import("../src/stripe");
    await expect(endTrialIfSpent(env, account.id)).resolves.toBeUndefined();
    // Still the trial, still refused by the proxy, and nothing granted here.
    expect((await db.allowance(env.DB, account.id))?.source).toBe("trial");
  });
});

describe("nothing is sold on top of a plan", () => {
  it("has no route that buys extra hours", async () => {
    const { cookie } = await signedInAs("no-topups@example.com");
    const sent = calls(() => json({}));
    const res = await postForm("/billing/topup", {}, { Cookie: cookie });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});

describe("what the page says about all of this", () => {
  it("promises the trial before the card is charged", async () => {
    const { cookie } = await signedInAs("page-trial@example.com");
    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Every plan starts with 5 hours to try");
    expect(html).toContain("Redeem a code");
  });

  it("says the plan is starting once the trial hours are gone", async () => {
    const { account, cookie, deviceId } = await claimDevice("page-spent@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TRIAL_ALLOWANCE.audio_seconds,
      summary_tokens: TRIAL_ALLOWANCE.summary_tokens,
      assistant_sessions: 0,
      source: "trial",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_page_spent", account_id: account.id, stripe_customer_id: "cus_page_spent",
      price_id: env.STRIPE_PRICE_PRO, tier: "pro", status: "trialing",
      current_period_end: new Date(Date.now() + 80 * 864e5).toISOString(), cancel_at_period_end: 0,
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TRIAL_ALLOWANCE.audio_seconds);

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("trial hours are used up");
    expect(html).toContain("Pro</strong> is starting now");
    expect(html).not.toContain("Add 5 hours");
  });

  it("tells a capped subscriber it is a hard stop, with nothing extra to buy", async () => {
    const { account, cookie, deviceId } = await claimDevice("page-capped@example.com");
    await db.putAllowance(env.DB, account.id, {
      audio_seconds: TIERS.starter.audio_seconds, summary_tokens: TIERS.starter.summary_tokens,
      assistant_sessions: 0, source: "starter",
    });
    await db.putSubscription(env.DB, {
      stripe_subscription_id: "sub_page_capped", account_id: account.id, stripe_customer_id: "cus_page_capped",
      price_id: env.STRIPE_PRICE_STARTER, tier: "starter", status: "active",
      current_period_end: new Date(Date.now() + 10 * 864e5).toISOString(), cancel_at_period_end: 0,
    });
    await db.recordUsage(env.DB, account.id, deviceId, "transcribe", TIERS.starter.audio_seconds);

    const html = await (await get("/", { Cookie: cookie })).text();
    expect(html).toContain("Recording is stopped until the month turns over");
    expect(html).toContain("nothing is being billed for going over");
    expect(html).not.toContain("Add 5 hours");
  });
});
