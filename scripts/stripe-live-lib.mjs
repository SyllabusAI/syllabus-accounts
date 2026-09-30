/**
 * The logic of the Stripe live-mode swap (scripts/stripe-live.mjs), with
 * nothing in it that touches the machine: no files, no environment, no
 * network. Stripe's answers are handed in, which is what lets
 * test/stripe-live.test.ts check every rule against made-up prices without a
 * key or a request. Like bulk-revoke-lib.mjs, it imports nothing from node:,
 * because the tests run in the Workers pool.
 *
 * What it decides:
 *
 *   ids       the four price ids, from flags or a JSON file, well formed and
 *             all different
 *   key       the Stripe key is a LIVE secret or restricted key, never a test
 *             one and never a publishable one
 *   prices    each price is live mode, active, USD, on an active product, and
 *             is the amount and shape src/tiers.ts sells: $9, $15 and $25 a
 *             month, and a one-time $5 top-up
 *   wrangler  the four STRIPE_PRICE_* vars rewritten in place, comments and
 *             all, and nothing else in the file touched
 *   events    the webhook events to subscribe to, read out of src/stripe.ts
 *             so this list cannot drift from the handler
 */

/** The four vars in wrangler.jsonc, by the slot this tool calls them. */
export const SLOTS = {
  starter: "STRIPE_PRICE_STARTER",
  standard: "STRIPE_PRICE_STANDARD",
  pro: "STRIPE_PRICE_PRO",
  topup: "STRIPE_PRICE_TOPUP",
};

/**
 * What each price must be, in cents. test/stripe-live.test.ts checks these
 * against TIERS and TOPUP in src/tiers.ts, so a price change there fails CI
 * until it is made here too.
 */
export const EXPECTED = {
  starter: { unit_amount: 900, currency: "usd", recurring: "month" },
  standard: { unit_amount: 1500, currency: "usd", recurring: "month" },
  pro: { unit_amount: 2500, currency: "usd", recurring: "month" },
  topup: { unit_amount: 500, currency: "usd", recurring: null },
};

/** The secrets a live switch needs, in the order to set them. */
export const SECRETS = [
  { name: "STRIPE_SECRET_KEY", what: "the live secret key (Developers > API keys, sk_live_...)" },
  { name: "STRIPE_WEBHOOK_SECRET", what: "the live webhook endpoint's signing secret (whsec_...)" },
  {
    name: "STRIPE_ACCOUNT_DELETION_KEY",
    what: "the live restricted key for account deletion (rk_live_...), see docs/stripe-live.md",
  },
];

const PRICE_ID = /^price_[A-Za-z0-9]{8,}$/;

/**
 * The four ids, from flags and/or a parsed JSON file. Flags win over the
 * file. Returns { ids, problems }; ids is only complete when problems is empty.
 */
export function parseIds(flags = {}, file = null) {
  const problems = [];
  const ids = {};
  if (file !== null && (typeof file !== "object" || Array.isArray(file))) {
    return { ids, problems: ["the ids file must be a JSON object like {\"starter\": \"price_...\", ...}"] };
  }
  for (const key of Object.keys(file ?? {})) {
    if (!(key in SLOTS)) problems.push(`the ids file has "${key}", which is not one of ${Object.keys(SLOTS).join(", ")}`);
  }
  for (const slot of Object.keys(SLOTS)) {
    const value = String(flags[slot] ?? file?.[slot] ?? "").trim();
    if (!value) {
      problems.push(`no id for ${slot} (--${slot} price_..., or "${slot}" in the ids file)`);
      continue;
    }
    if (!PRICE_ID.test(value)) {
      problems.push(`${slot}: "${value}" is not a price id (price_ then at least 8 letters or digits; a prod_ id is the product, not the price)`);
      continue;
    }
    ids[slot] = value;
  }
  const seen = new Map();
  for (const [slot, id] of Object.entries(ids)) {
    if (seen.has(id)) problems.push(`${slot} and ${seen.get(id)} are the same id, ${id}`);
    else seen.set(id, slot);
  }
  return { ids, problems };
}

/** Whether a key can be used to check live prices. Returns a problem, or "". */
export function checkKey(key) {
  const k = String(key ?? "");
  if (!k) return "STRIPE_SECRET_KEY is not set in the environment";
  if (/^pk_/.test(k)) return "STRIPE_SECRET_KEY is a publishable key; it needs a secret (sk_live_) or restricted (rk_live_) key";
  if (/^(sk|rk)_test_/.test(k)) return "STRIPE_SECRET_KEY is a TEST key; live prices can only be read with a live one";
  if (!/^(sk|rk)_live_/.test(k)) return "STRIPE_SECRET_KEY does not look like a Stripe live key (sk_live_ or rk_live_)";
  return "";
}

function dollars(cents) {
  return "$" + (cents / 100).toFixed(2);
}

/**
 * Everything wrong with one price, as Stripe returned it with
 * `expand[]=product`. An empty `errors` means it is safe to point `slot` at.
 * `warnings` are worth reading and do not stop the swap.
 */
export function checkPrice(slot, price, expected = EXPECTED[slot]) {
  const errors = [];
  const warnings = [];
  if (!expected) return { errors: [`unknown slot ${slot}`], warnings };
  if (!price || price.object !== "price") return { errors: [`${slot}: Stripe did not return a price`], warnings };

  if (price.livemode !== true) errors.push(`${slot}: ${price.id} is a TEST mode price, not a live one`);
  if (price.active !== true) errors.push(`${slot}: ${price.id} is archived (inactive) in Stripe`);
  if (price.currency !== expected.currency) {
    errors.push(`${slot}: ${price.id} is in ${String(price.currency).toUpperCase()}, expected ${expected.currency.toUpperCase()}`);
  }
  if (price.billing_scheme && price.billing_scheme !== "per_unit") {
    errors.push(`${slot}: ${price.id} is priced ${price.billing_scheme}, expected a flat per-unit price`);
  }
  if (price.unit_amount !== expected.unit_amount) {
    const got = typeof price.unit_amount === "number" ? dollars(price.unit_amount) : "no fixed amount";
    errors.push(`${slot}: ${price.id} is ${got}, expected ${dollars(expected.unit_amount)}`);
  }

  if (expected.recurring) {
    const r = price.recurring;
    if (price.type !== "recurring" || !r) {
      errors.push(`${slot}: ${price.id} is a one-time price, expected a monthly subscription price`);
    } else {
      if (r.interval !== expected.recurring || (r.interval_count ?? 1) !== 1) {
        errors.push(`${slot}: ${price.id} bills every ${r.interval_count ?? 1} ${r.interval}, expected every 1 ${expected.recurring}`);
      }
      if (r.usage_type && r.usage_type !== "licensed") {
        errors.push(`${slot}: ${price.id} is metered, expected a flat monthly price`);
      }
    }
  } else if (price.type !== "one_time") {
    errors.push(`${slot}: ${price.id} is a recurring price, expected a ONE-TIME price (a top-up is a single payment)`);
  }

  const product = price.product;
  if (product && typeof product === "object") {
    if (product.active === false) errors.push(`${slot}: the product behind ${price.id} (${product.id}) is archived`);
    if (product.livemode === false) errors.push(`${slot}: the product behind ${price.id} (${product.id}) is a test mode product`);
    if (!product.tax_code) {
      warnings.push(`${slot}: the product "${product.name ?? product.id}" has no tax code, so Stripe Tax uses the account default`);
    }
  } else {
    warnings.push(`${slot}: the product behind ${price.id} was not expanded, so it was not checked`);
  }
  // The terms say "plus any sales tax", which is exclusive pricing.
  if (price.tax_behavior === "inclusive") {
    errors.push(`${slot}: ${price.id} is tax-inclusive; the terms promise the price plus any sales tax (exclusive)`);
  } else if (price.tax_behavior !== "exclusive") {
    warnings.push(`${slot}: ${price.id} has tax behavior "${price.tax_behavior ?? "unspecified"}"; set it to exclusive so tax is added on top`);
  }
  return { errors, warnings };
}

/**
 * Check all four. `prices` maps slot to the price Stripe returned, or to an
 * Error when the lookup failed.
 */
export function checkAll(ids, prices) {
  const errors = [];
  const warnings = [];
  for (const slot of Object.keys(SLOTS)) {
    const got = prices[slot];
    if (got instanceof Error) {
      errors.push(`${slot}: could not read ${ids[slot]} from Stripe: ${got.message}`);
      continue;
    }
    const r = checkPrice(slot, got);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors, warnings };
}

/**
 * wrangler.jsonc with the four vars pointed at `ids`. Only the quoted value
 * after each var's name changes, so every comment stays where it was. Throws
 * when a var is missing or appears more than once, rather than guessing which
 * one is meant.
 */
export function rewriteWrangler(text, ids) {
  let out = String(text);
  const before = {};
  for (const [slot, name] of Object.entries(SLOTS)) {
    const pattern = new RegExp(`("${name}"\\s*:\\s*)"([^"]*)"`, "g");
    const matches = [...out.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`wrangler.jsonc has ${matches.length} "${name}" entries, expected exactly 1`);
    before[slot] = matches[0][2];
    if (!(slot in ids)) continue;
    out = out.replace(pattern, (_m, lead) => `${lead}"${ids[slot]}"`);
  }
  return { text: out, before };
}

/** A string var out of wrangler.jsonc, e.g. PUBLIC_URL. */
export function wranglerVar(text, name) {
  return new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(String(text))?.[1] ?? "";
}

/** The webhook events src/stripe.ts handles, read from its HANDLED set. */
export function handledEvents(stripeSource) {
  const block = /const HANDLED\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(String(stripeSource))?.[1];
  if (!block) throw new Error("could not find the HANDLED set in src/stripe.ts");
  const events = [...block.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
  if (!events.length) throw new Error("the HANDLED set in src/stripe.ts is empty");
  return events;
}

/** Where Stripe delivers, from PUBLIC_URL. */
export function webhookUrl(publicUrl) {
  return String(publicUrl).replace(/\/+$/, "") + "/stripe/webhook";
}

/** The next steps, printed and never run: secrets, the webhook, and the deploy. */
export function nextSteps({ publicUrl, events }) {
  const lines = [];
  lines.push("Set the live secrets (each command prompts for the value; nothing lands in shell history):");
  for (const s of SECRETS) lines.push(`  npx wrangler secret put ${s.name}    # ${s.what}`);
  lines.push("");
  lines.push("The live webhook endpoint (Developers > Webhooks > Add endpoint):");
  lines.push(`  URL:     ${webhookUrl(publicUrl)}`);
  lines.push("  Events:");
  for (const e of events) lines.push(`    ${e}`);
  lines.push("");
  lines.push("Then commit wrangler.jsonc on a branch and merge it by PR; the merge deploys (deploy.yml).");
  return lines;
}
