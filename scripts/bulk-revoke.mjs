#!/usr/bin/env node
/**
 * Incident tool: end every credential Syllabus has handed out, for all
 * accounts or a chosen few. Runs from an operator's machine, never in the
 * Worker. docs/bulk-revoke.md is the guide; the logic is in
 * scripts/bulk-revoke-lib.mjs, and this file only connects it to the world.
 *
 *   infisical run --env=prod -- node scripts/bulk-revoke.mjs                 dry run, changes nothing
 *   infisical run --env=prod -- node scripts/bulk-revoke.mjs --execute      does it, after a typed confirmation
 *   ... --only acc_1,acc_2     just these accounts
 *   ... --run-id NAME          resume or retry a run (default: a new one, printed at the start)
 *   ... --skip-drive           leave Drive grants alone
 *   ... --batch 50             accounts per batch, at most 90
 *   ... --per-second 5         Google revoke calls per second
 *   ... --out-dir DIR          where the audit log goes (default: the current directory)
 *
 * Environment (never flags, so nothing lands in shell history or `ps`):
 *   CLOUDFLARE_API_TOKEN   a token allowed to edit D1 on this account
 *   DRIVE_KEY              the key Drive grants are sealed under (needed unless --skip-drive)
 *   DRIVE_KEY_PREVIOUS     during a rotation, the key being retired
 *   CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID   default to the values in wrangler.jsonc
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bulkRevoke, parseLedger, safe } from "./bulk-revoke-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function wrangler(name) {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  return new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1] ?? "";
}

/** D1 through Cloudflare's HTTP API: parameters are bound, never spliced into the SQL. */
function d1(env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID || wrangler("account_id");
  const database = env.D1_DATABASE_ID || wrangler("database_id");
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not set");
  if (!account || !database) throw new Error("no account or database id (wrangler.jsonc, or CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID)");
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
  return {
    async query(sql, params) {
      for (let attempt = 1; ; attempt += 1) {
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql, params }),
          });
        } catch (err) {
          if (attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue; }
          throw new Error(`could not reach Cloudflare: ${safe(err.message)}`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) throw new Error(`D1 refused a query (HTTP ${res.status}): ${safe(body.errors?.[0]?.message)}`);
        const first = body.result?.[0] ?? {};
        return { rows: first.results ?? [], changes: Number(first.meta?.changes ?? 0) };
      }
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean", default: false },
      only: { type: "string" },
      "run-id": { type: "string" },
      "skip-drive": { type: "boolean", default: false },
      batch: { type: "string", default: "50" },
      "per-second": { type: "string", default: "5" },
      "out-dir": { type: "string", default: "." },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^[/ *]+/gm, ""));

  const env = process.env;
  const runId = values["run-id"] || "run-" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const file = join(values["out-dir"], `bulk-revoke-${runId}.jsonl`);
  const done = existsSync(file) ? parseLedger(readFileSync(file, "utf8")) : new Set();
  let fd = null;
  const append = async (row) => {
    if (fd === null) {
      mkdirSync(values["out-dir"], { recursive: true });
      fd = openSync(file, "a", 0o600); // the audit log is account ids and step names, still not for everyone
    }
    appendFileSync(fd, JSON.stringify(row) + "\n");
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await bulkRevoke(
      {
        db: d1(env),
        fetch,
        keys: env.DRIVE_KEY ? { DRIVE_KEY: env.DRIVE_KEY, DRIVE_KEY_PREVIOUS: env.DRIVE_KEY_PREVIOUS || "" } : null,
        done,
        append,
        prompt: (text) => rl.question(text),
        out: (line) => console.log(line),
      },
      {
        execute: values.execute,
        only: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : null,
        batchSize: Number(values.batch),
        perSecond: Number(values["per-second"]),
        skipDrive: values["skip-drive"],
        runId,
      },
    );
    if (result.executed) console.log(`Audit log: ${file}`);
    if (result.aborted) process.exitCode = 1;
    else if (result.failures.length) process.exitCode = 2;
  } finally {
    rl.close();
    if (fd !== null) closeSync(fd);
  }
}

main().catch((err) => {
  console.error("bulk-revoke: " + safe(err.message));
  process.exitCode = 1;
});
