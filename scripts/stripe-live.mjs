#!/usr/bin/env node
/**
 * Launch tool: point this Worker at Stripe's LIVE prices. Runs from an
 * operator's machine, never in the Worker. docs/stripe-live.md is the guide;
 * the rules are in scripts/stripe-live-lib.mjs, and this file only connects
 * them to the world.
 *
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-live.mjs \
 *     --starter price_... --standard price_... --pro price_... --topup price_...
 *   ... --ids ids.json      the four ids as {"starter": "price_...", ...} instead of flags
 *   ... --dry-run           check everything, print the diff, write nothing
 *
 * Each price is read from Stripe (GET /v1/prices/<id>, nothing is written
 * there) and checked: live mode, active, USD, and the amount and interval
 * src/tiers.ts sells. Only when all four pass are the STRIPE_PRICE_* vars in
 * wrangler.jsonc rewritten, and worker-configuration.d.ts regenerated to
 * match (it carries the ids as literal types, and CI checks it is current). It then PRINTS the secrets to set and the webhook
 * to create; it never sets a secret and never deploys. The deploy is a PR
 * that merges the wrangler.jsonc change.
 *
 * Environment (never a flag, so the key stays out of shell history and `ps`):
 *   STRIPE_SECRET_KEY   a live key that can read Prices and Products
 *                       (sk_live_..., or an rk_live_... with those two on Read)
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkAll, checkKey, handledEvents, nextSteps, parseIds, rewriteWrangler, SLOTS, wranglerVar } from "./stripe-live-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(root, "wrangler.jsonc");

/**
 * worker-configuration.d.ts, regenerated for the new wrangler.jsonc.
 *
 * `wrangler types` writes each var as a literal type, so the price ids are in
 * that file too, and CI fails a PR whose copy is stale. It is generated in a
 * scratch copy of the project rather than here because wrangler also reads
 * .dev.vars, and a local one adds its secret NAMES to the file, which CI
 * (with no .dev.vars) would then call stale. Local codegen only: nothing is
 * sent anywhere.
 */
function regenerateTypes() {
  const scratch = mkdtempSync(join(tmpdir(), "stripe-live-"));
  try {
    cpSync(WRANGLER, join(scratch, "wrangler.jsonc"));
    cpSync(join(root, "src"), join(scratch, "src"), { recursive: true });
    execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "types"], {
      cwd: scratch,
      stdio: ["ignore", "ignore", "inherit"],
    });
    cpSync(join(scratch, "worker-configuration.d.ts"), join(root, "worker-configuration.d.ts"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One price, with its product, from Stripe's API. Read-only. */
async function fetchPrice(key, id) {
  const url = `https://api.stripe.com/v1/prices/${encodeURIComponent(id)}?expand[]=product`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch (err) {
    return new Error(`could not reach Stripe: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return new Error(`HTTP ${res.status}: ${body?.error?.message ?? "no message"}`);
  return body;
}

async function main() {
  const { values } = parseArgs({
    options: {
      starter: { type: "string" },
      standard: { type: "string" },
      pro: { type: "string" },
      topup: { type: "string" },
      ids: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^[/ *]+/gm, ""));

  let file = null;
  if (values.ids) {
    try {
      file = JSON.parse(readFileSync(values.ids, "utf8"));
    } catch (err) {
      throw new Error(`could not read ${values.ids} as JSON: ${err.message}`);
    }
  }
  const { ids, problems } = parseIds(values, file);
  const keyProblem = checkKey(process.env.STRIPE_SECRET_KEY);
  if (keyProblem) problems.push(keyProblem);
  if (problems.length) {
    for (const p of problems) console.error("  x " + p);
    process.exitCode = 1;
    return;
  }

  console.log("Reading the four prices from Stripe (read-only)...");
  const prices = {};
  await Promise.all(
    Object.keys(SLOTS).map(async (slot) => {
      prices[slot] = await fetchPrice(process.env.STRIPE_SECRET_KEY, ids[slot]);
    }),
  );
  const { errors, warnings } = checkAll(ids, prices);
  for (const slot of Object.keys(SLOTS)) {
    const p = prices[slot];
    if (p instanceof Error) continue;
    const name = typeof p.product === "object" ? p.product?.name : p.product;
    console.log(`  ${slot.padEnd(8)} ${p.id}  ${name ?? ""}  ${p.unit_amount ?? "?"} ${p.currency ?? ""} ${p.recurring ? "per " + p.recurring.interval : "one-time"}`);
  }
  for (const w of warnings) console.log("  ! " + w);
  if (errors.length) {
    for (const e of errors) console.error("  x " + e);
    console.error("\nNothing was written. Fix the prices in Stripe (or the ids) and run this again.");
    process.exitCode = 1;
    return;
  }
  console.log("All four prices match src/tiers.ts.\n");

  const current = readFileSync(WRANGLER, "utf8");
  const { text, before } = rewriteWrangler(current, ids);
  for (const [slot, name] of Object.entries(SLOTS)) {
    const same = before[slot] === ids[slot];
    console.log(`  ${name.padEnd(22)} ${before[slot] || '""'}  ->  ${ids[slot]}${same ? "  (unchanged)" : ""}`);
  }
  if (values["dry-run"]) {
    console.log("\n--dry-run: wrangler.jsonc and worker-configuration.d.ts were NOT written.");
  } else {
    if (text === current) console.log("\nwrangler.jsonc already has these ids.");
    else {
      writeFileSync(WRANGLER, text);
      console.log("\nwrangler.jsonc updated.");
    }
    regenerateTypes();
    console.log("worker-configuration.d.ts regenerated to match (commit both files).");
  }

  const events = handledEvents(readFileSync(join(root, "src", "stripe.ts"), "utf8"));
  console.log("\n" + nextSteps({ publicUrl: wranglerVar(current, "PUBLIC_URL"), events }).join("\n"));
}

main().catch((err) => {
  console.error("stripe-live: " + err.message);
  process.exitCode = 1;
});
