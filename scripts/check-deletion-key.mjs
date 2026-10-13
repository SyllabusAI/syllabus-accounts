#!/usr/bin/env node
/**
 * Pre-launch check: is the restricted account-deletion key enough to delete
 * an account that pays? docs/stripe-live.md ("Keys") lists Subscriptions,
 * Refunds and Customers on Write and Invoices on Read, worked out by reading
 * the code. This asks Stripe instead, once, in the sandbox, before the live
 * key is made with the same permissions.
 *
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_ACCOUNT_DELETION_KEY=rk_test_... \
 *     node scripts/check-deletion-key.mjs
 *   ... --starter price_... --standard price_...   sandbox prices, when wrangler.jsonc holds live ones
 *
 * Sandbox keys only, because it buys a plan. With the secret key it makes a
 * customer with Stripe's test Visa, subscribes them to Starter and upgrades
 * them to Standard the way POST /billing/upgrade does, so the month is paid
 * on two invoices (the case that lists invoices). Then it runs what account
 * deletion runs, endSubscription and deleteCustomer from src/stripe.ts,
 * bundled as they are, on a client built from the restricted key. When
 * Stripe refuses a call, its message names the permission it wanted.
 *
 * Whatever the restricted key could not finish is finished with the secret
 * key at the end, so no test subscription is left running.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import esbuild from "esbuild";
import Stripe from "stripe";
import { wranglerVar } from "./stripe-live-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function refuse(message) {
  console.error(`check-deletion-key: ${message}`);
  process.exit(2);
}

const { values } = parseArgs({ options: { starter: { type: "string" }, standard: { type: "string" } } });
const secret = process.env.STRIPE_SECRET_KEY ?? "";
const restricted = process.env.STRIPE_ACCOUNT_DELETION_KEY ?? "";
if (!secret.startsWith("sk_test_")) {
  refuse("STRIPE_SECRET_KEY must be a sandbox secret key (sk_test_...). This buys a plan, so a live key is refused.");
}
if (!restricted.startsWith("rk_test_")) {
  refuse("STRIPE_ACCOUNT_DELETION_KEY must be the sandbox restricted key under test (rk_test_...).");
}

const wrangler = readFileSync(join(root, "wrangler.jsonc"), "utf8");
const prices = {
  starter: values.starter || wranglerVar(wrangler, "STRIPE_PRICE_STARTER"),
  standard: values.standard || wranglerVar(wrangler, "STRIPE_PRICE_STANDARD"),
};

/**
 * src/stripe.ts as the Worker has it, bundled for Node. Local only: esbuild
 * comes with wrangler, and nothing is sent anywhere.
 */
async function productionCode() {
  const dir = mkdtempSync(join(tmpdir(), "check-deletion-key-"));
  try {
    const outfile = join(dir, "stripe.mjs");
    await esbuild.build({
      entryPoints: [join(root, "src", "stripe.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "error",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const admin = new Stripe(secret);
const deletion = new Stripe(restricted);

for (const [slot, id] of Object.entries(prices)) {
  try {
    await admin.prices.retrieve(id);
  } catch (err) {
    refuse(
      `could not read the sandbox ${slot} price ${id || "(none set)"}: ${err.message}\n` +
        `After the live swap wrangler.jsonc holds live ids; pass sandbox ones with --${slot} price_...`,
    );
  }
}

const { endSubscription, deleteCustomer, periodStart } = await productionCode();

let customer;
let sub;
let canceled = false;
let customerGone = false;
const problems = [];
try {
  customer = await admin.customers.create({
    name: "Deletion key check",
    metadata: { made_by: "scripts/check-deletion-key.mjs" },
  });
  const card = await admin.paymentMethods.attach("pm_card_visa", { customer: customer.id });
  sub = await admin.subscriptions.create({
    customer: customer.id,
    items: [{ price: prices.starter }],
    default_payment_method: card.id,
    payment_behavior: "error_if_incomplete",
  });
  // The upgrade exactly as POST /billing/upgrade (src/billing.ts) asks for it.
  await admin.subscriptions.update(sub.id, {
    items: [{ id: sub.items.data[0].id, price: prices.standard }],
    proration_behavior: "always_invoice",
    proration_date: periodStart(sub),
    payment_behavior: "error_if_incomplete",
  });
  console.log(`Sandbox: customer ${customer.id} on ${sub.id}, Starter upgraded to Standard, paid on two invoices.`);
  console.log("Now account deletion's own code, on the restricted key:");

  try {
    const ended = await endSubscription(deletion, sub.id);
    canceled = ended.canceled;
    if (!ended.canceled) problems.push("the subscription was not canceled");
    if (ended.refundFailed) problems.push("a refund was owed and not made (see the REFUND OWED line above)");
    console.log(`  cancel and refund     ${ended.canceled ? "canceled" : "NOT canceled"}, $${(ended.refunded / 100).toFixed(2)} refunded`);
  } catch (err) {
    problems.push(`canceling was refused: ${err.message}`);
    console.log("  cancel and refund     REFUSED");
  }

  try {
    customerGone = await deleteCustomer(deletion, customer.id);
    console.log(`  delete the customer   ${customerGone ? "deleted" : "Stripe did not have it"}`);
    if (!customerGone) problems.push("the customer was not there to delete");
  } catch (err) {
    problems.push(`deleting the customer was refused: ${err.message}`);
    console.log("  delete the customer   REFUSED");
  }
} catch (err) {
  problems.push(`setting up the test account failed, before the restricted key was used: ${err.message}`);
} finally {
  if (sub && !canceled) await admin.subscriptions.cancel(sub.id).catch(() => {});
  if (customer && !customerGone) await admin.customers.del(customer.id).catch(() => {});
}

if (problems.length) {
  console.log("\nThe restricted key is NOT enough:");
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log(
    "Add what Stripe asked for to the sandbox key, run this again, then write it into\n" +
      "src/env.ts and docs/stripe-live.md before making the live key.",
  );
  process.exit(1);
}
console.log("\nThe restricted key is enough. Make the live one with the same permissions.");
