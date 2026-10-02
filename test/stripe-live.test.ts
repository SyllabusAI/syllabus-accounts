import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs ops script, no types
import * as live from "../scripts/stripe-live-lib.mjs";
// @ts-expect-error - Vite's raw import, the file as text
import stripeSource from "../src/stripe.ts?raw";
// @ts-expect-error - Vite's raw import, the file as text
import wranglerSource from "../wrangler.jsonc?raw";
import { TIERS, TOPUP } from "../src/tiers";

// The live-mode swap's rules, against made-up Stripe answers. Nothing here
// has a key or reaches Stripe: scripts/stripe-live.mjs is the only thing that
// does, and only when an operator runs it.

const IDS = {
  starter: "price_LiveStarter01",
  standard: "price_LiveStandard1",
  pro: "price_LivePro000001",
  topup: "price_LiveTopup0001",
};

/** A price as GET /v1/prices/<id>?expand[]=product returns it, live and correct. */
function price(slot: keyof typeof IDS, over: Record<string, unknown> = {}) {
  const expected = live.EXPECTED[slot];
  return {
    object: "price",
    id: IDS[slot],
    livemode: true,
    active: true,
    currency: "usd",
    billing_scheme: "per_unit",
    unit_amount: expected.unit_amount,
    type: expected.recurring ? "recurring" : "one_time",
    recurring: expected.recurring ? { interval: "month", interval_count: 1, usage_type: "licensed" } : null,
    tax_behavior: "exclusive",
    product: { id: `prod_${slot}`, object: "product", active: true, livemode: true, name: slot, tax_code: "txcd_10103000" },
    ...over,
  };
}

function allGood() {
  return { starter: price("starter"), standard: price("standard"), pro: price("pro"), topup: price("topup") };
}

describe("what the swap expects of each price", () => {
  it("is the same money src/tiers.ts sells", () => {
    expect(live.EXPECTED.starter.unit_amount).toBe(TIERS.starter.price_usd * 100);
    expect(live.EXPECTED.standard.unit_amount).toBe(TIERS.standard.price_usd * 100);
    expect(live.EXPECTED.pro.unit_amount).toBe(TIERS.pro.price_usd * 100);
    expect(live.EXPECTED.topup.unit_amount).toBe(TOPUP.price_usd * 100);
    expect(live.EXPECTED.topup.recurring).toBeNull();
    for (const slot of ["starter", "standard", "pro"]) expect(live.EXPECTED[slot].recurring).toBe("month");
  });
});

describe("checking prices against Stripe's answers", () => {
  it("passes four live prices that match the tiers", () => {
    const r = live.checkAll(IDS, allGood());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("refuses a test mode price, which is the mistake this tool exists for", () => {
    const r = live.checkPrice("starter", price("starter", { livemode: false }));
    expect(r.errors.join()).toMatch(/TEST mode/);
  });

  it("refuses an archived price and an archived product", () => {
    expect(live.checkPrice("pro", price("pro", { active: false })).errors.join()).toMatch(/archived/);
    const product = { id: "prod_pro", active: false, livemode: true, tax_code: "txcd_10103000" };
    expect(live.checkPrice("pro", price("pro", { product })).errors.join()).toMatch(/product .* is archived/);
  });

  it("refuses a swapped pair: the right prices in the wrong slots", () => {
    const r = live.checkAll(IDS, { ...allGood(), starter: price("standard"), standard: price("starter") });
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/starter: .* is \$15\.00, expected \$9\.00/);
    expect(r.errors[1]).toMatch(/standard: .* is \$9\.00, expected \$15\.00/);
  });

  it("refuses the wrong currency", () => {
    expect(live.checkPrice("standard", price("standard", { currency: "eur" })).errors.join()).toMatch(/EUR, expected USD/);
  });

  it("refuses a yearly or every-three-months plan", () => {
    const yearly = price("pro", { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } });
    expect(live.checkPrice("pro", yearly).errors.join()).toMatch(/every 1 year, expected every 1 month/);
    const quarterly = price("pro", { recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } });
    expect(live.checkPrice("pro", quarterly).errors.join()).toMatch(/every 3 month/);
  });

  it("refuses a metered or tiered plan", () => {
    const metered = price("starter", { recurring: { interval: "month", interval_count: 1, usage_type: "metered" } });
    expect(live.checkPrice("starter", metered).errors.join()).toMatch(/metered/);
    expect(live.checkPrice("starter", price("starter", { billing_scheme: "tiered", unit_amount: null })).errors.join()).toMatch(/tiered/);
  });

  it("refuses a recurring top-up and a one-time plan", () => {
    const monthlyTopup = price("topup", { type: "recurring", recurring: { interval: "month", interval_count: 1 } });
    expect(live.checkPrice("topup", monthlyTopup).errors.join()).toMatch(/ONE-TIME/);
    expect(live.checkPrice("starter", price("starter", { type: "one_time", recurring: null })).errors.join()).toMatch(/one-time price, expected a monthly/);
  });

  it("refuses tax-inclusive pricing, and warns on unspecified tax behavior or a missing tax code", () => {
    expect(live.checkPrice("pro", price("pro", { tax_behavior: "inclusive" })).errors.join()).toMatch(/tax-inclusive/);
    const unspecified = live.checkPrice("pro", price("pro", { tax_behavior: "unspecified" }));
    expect(unspecified.errors).toEqual([]);
    expect(unspecified.warnings.join()).toMatch(/exclusive/);
    const noCode = live.checkPrice("pro", price("pro", { product: { id: "prod_pro", active: true, livemode: true, tax_code: null } }));
    expect(noCode.errors).toEqual([]);
    expect(noCode.warnings.join()).toMatch(/no tax code/);
  });

  it("reports a price Stripe could not find rather than skipping it", () => {
    const r = live.checkAll(IDS, { ...allGood(), topup: new Error("HTTP 404: No such price: 'price_LiveTopup0001'") });
    expect(r.errors).toEqual([expect.stringMatching(/topup: could not read price_LiveTopup0001 .*No such price/)]);
  });

  it("refuses something that is not a price at all", () => {
    expect(live.checkPrice("pro", { object: "product", id: "prod_x" }).errors.join()).toMatch(/did not return a price/);
  });
});

describe("reading the ids", () => {
  it("takes all four from flags, or from a file, with flags winning", () => {
    expect(live.parseIds(IDS)).toEqual({ ids: IDS, problems: [] });
    expect(live.parseIds({}, IDS)).toEqual({ ids: IDS, problems: [] });
    const r = live.parseIds({ pro: "price_FromTheFlag01" }, IDS);
    expect(r.ids.pro).toBe("price_FromTheFlag01");
  });

  it("names every missing, malformed or duplicated id", () => {
    const r = live.parseIds({ starter: "prod_Abcdefgh123", standard: IDS.pro, pro: IDS.pro });
    expect(r.problems.join("\n")).toMatch(/starter: "prod_Abcdefgh123" is not a price id/);
    expect(r.problems.join("\n")).toMatch(/pro and standard are the same id/);
    expect(r.problems.join("\n")).toMatch(/no id for topup/);
  });

  it("refuses a file with a key it does not know, or one that is not an object", () => {
    expect(live.parseIds({}, { ...IDS, premium: "price_Whatever001" }).problems.join()).toMatch(/"premium"/);
    expect(live.parseIds({}, [IDS.starter]).problems.join()).toMatch(/JSON object/);
  });
});

describe("the key", () => {
  it("wants a live secret or restricted key", () => {
    expect(live.checkKey("sk_live_abc")).toBe("");
    expect(live.checkKey("rk_live_abc")).toBe("");
    expect(live.checkKey("")).toMatch(/not set/);
    expect(live.checkKey("sk_test_abc")).toMatch(/TEST key/);
    expect(live.checkKey("rk_test_abc")).toMatch(/TEST key/);
    expect(live.checkKey("pk_live_abc")).toMatch(/publishable/);
    expect(live.checkKey("whsec_abc")).toMatch(/does not look like/);
  });
});

describe("rewriting wrangler.jsonc", () => {
  it("changes the four vars in the real file and nothing else", () => {
    const { text, before } = live.rewriteWrangler(wranglerSource, IDS);
    expect(before.topup).toBe("");
    for (const [slot, name] of Object.entries(live.SLOTS) as [keyof typeof IDS, string][]) {
      expect(live.wranglerVar(text, name)).toBe(IDS[slot]);
    }
    const changed = (wranglerSource as string).split("\n").filter((line, i) => line !== text.split("\n")[i]);
    expect(changed).toHaveLength(4);
    expect(changed.every((line) => /"STRIPE_PRICE_(STARTER|STANDARD|PRO|TOPUP)"/.test(line))).toBe(true);
    // Every comment survives, so the explanation beside each var does too.
    expect(text.split("\n").length).toBe((wranglerSource as string).split("\n").length);
  });

  it("is a no-op when run twice", () => {
    const once = live.rewriteWrangler(wranglerSource, IDS).text;
    expect(live.rewriteWrangler(once, IDS).text).toBe(once);
  });

  it("refuses a file where a var is missing or doubled, rather than guessing", () => {
    const missing = (wranglerSource as string).replace(/"STRIPE_PRICE_PRO".*\n/, "");
    expect(() => live.rewriteWrangler(missing, IDS)).toThrow(/0 "STRIPE_PRICE_PRO"/);
    const doubled = (wranglerSource as string).replace(/("STRIPE_PRICE_PRO".*\n)/, "$1$1");
    expect(() => live.rewriteWrangler(doubled, IDS)).toThrow(/2 "STRIPE_PRICE_PRO"/);
  });
});

describe("what the operator is told to set up", () => {
  it("lists the events the webhook handler actually handles", () => {
    expect(live.handledEvents(stripeSource)).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
    ]);
  });

  it("points the webhook at PUBLIC_URL and prints, never runs, the three secrets", () => {
    const publicUrl = live.wranglerVar(wranglerSource, "PUBLIC_URL");
    expect(live.webhookUrl(publicUrl + "/")).toBe(`${publicUrl}/stripe/webhook`);
    const out = live.nextSteps({ publicUrl, events: live.handledEvents(stripeSource) }).join("\n");
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_ACCOUNT_DELETION_KEY"]) {
      expect(out).toContain(`npx wrangler secret put ${name}`);
    }
    expect(out).toContain(`${publicUrl}/stripe/webhook`);
    expect(out).toContain("customer.subscription.paused");
  });
});
