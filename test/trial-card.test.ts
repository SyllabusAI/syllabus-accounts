import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { ORIGIN, signedInAs } from "./helpers";

const SECRET = "whsec_test_secret";
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function sign(payload: string): Promise<string> {
  const at = nowSeconds();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`));
  return `t=${at},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function deliver(event: unknown) {
  const raw = JSON.stringify(event);
  return SELF.fetch(ORIGIN + "/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": await sign(raw) },
    body: raw,
  });
}

let seq = 0;
/** A trialing subscription Checkout just started for `accountId`, on card `pm`. */
function trialStarted(accountId: string, subId: string, pm: string | null) {
  return {
    id: `evt_card_${++seq}_${Math.random().toString(36).slice(2, 8)}`,
    type: "customer.subscription.created",
    data: {
      object: {
        id: subId,
        object: "subscription",
        customer: `cus_${subId}`,
        status: "trialing",
        cancel_at_period_end: false,
        default_payment_method: pm,
        metadata: { account_id: accountId },
        items: { data: [{ id: "si_1", price: { id: "price_test_starter" }, current_period_end: nowSeconds() + 90 * 86400 }] },
      },
    },
  };
}

type Call = { method: string; path: string; body: string };

/** Stripe's API: each payment method's card fingerprint, and the trial-ending update. */
function stripeApi(fingerprints: Record<string, string>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, path: u.pathname, body: typeof init.body === "string" ? init.body : "" });
      const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
      const pm = u.pathname.match(/^\/v1\/payment_methods\/([^/]+)$/);
      if (pm) return json({ id: pm[1], object: "payment_method", type: "card", card: { fingerprint: fingerprints[pm[1]] } });
      const sub = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
      if (sub && method === "POST") return json({ id: sub[1], object: "subscription", status: "active" });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
  return calls;
}

const endedTrials = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/subscriptions/") && c.body.includes("trial_end=now")).map((c) => c.path.split("/").pop());

describe("one free trial per card (F-10)", () => {
  const switched = env as { TRIAL_CARD_CHECK?: string };
  beforeEach(() => {
    switched.TRIAL_CARD_CHECK = "on";
  });
  afterEach(() => {
    delete switched.TRIAL_CARD_CHECK;
    vi.unstubAllGlobals();
  });

  it("lets a card's first trial stand and keeps only a hash of the card", async () => {
    const calls = stripeApi({ pm_first: "fp_card_one" });
    const { account } = await signedInAs("card-first@example.com");
    expect((await deliver(trialStarted(account.id, "sub_card_first", "pm_first"))).status).toBe(200);
    expect(endedTrials(calls)).toEqual([]);
    const rows = await env.DB.prepare("SELECT * FROM trial_cards WHERE account_id = ?").bind(account.id).all<Record<string, string>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].card_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.results)).not.toContain("fp_card_one");
  });

  it("ends the trial of a second account on the same card, which charges the card", async () => {
    const calls = stripeApi({ pm_a: "fp_shared", pm_b: "fp_shared" });
    const a = await signedInAs("farm-a@example.com");
    const b = await signedInAs("farm-b@example.com");
    await deliver(trialStarted(a.account.id, "sub_farm_a", "pm_a"));
    await deliver(trialStarted(b.account.id, "sub_farm_b", "pm_b"));
    expect(endedTrials(calls)).toEqual(["sub_farm_b"]);
  });

  it("does not count an account's own card against it, or a card it never had", async () => {
    const calls = stripeApi({ pm_same: "fp_same", pm_other: "fp_other" });
    const { account } = await signedInAs("own-card@example.com");
    await deliver(trialStarted(account.id, "sub_own", "pm_same"));
    await deliver({ ...trialStarted(account.id, "sub_own", "pm_same"), type: "customer.subscription.updated" });
    const other = await signedInAs("other-card@example.com");
    await deliver(trialStarted(other.account.id, "sub_other", "pm_other"));
    expect(endedTrials(calls)).toEqual([]);
  });

  it("checks nothing for a subscription that took no card", async () => {
    const calls = stripeApi({});
    const { account } = await signedInAs("no-card@example.com");
    expect((await deliver(trialStarted(account.id, "sub_no_card", null))).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("reads no card and keeps nothing while the check is switched off", async () => {
    delete switched.TRIAL_CARD_CHECK;
    const calls = stripeApi({ pm_off: "fp_off" });
    const { account } = await signedInAs("card-off@example.com");
    await deliver(trialStarted(account.id, "sub_card_off", "pm_off"));
    expect(calls).toHaveLength(0);
    expect(await db.trialCardOwner(env.DB, "anything")).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM trial_cards WHERE account_id = ?").bind(account.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
