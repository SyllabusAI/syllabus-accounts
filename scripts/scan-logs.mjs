#!/usr/bin/env node
/**
 * Does anything the Worker logged in production carry personal data or a
 * secret?
 *
 * test/no-pii-in-logs.ts holds every test in the suite to this; this checks
 * the real thing. Capture a session, then scan it:
 *
 *   npx wrangler tail --format json > tail.jsonl &      # stop it with kill
 *   node scripts/scan-logs.mjs tail.jsonl
 *
 * Only what this Worker wrote is checked: each event's `logs` and
 * `exceptions`. The request URL Cloudflare records beside them is the
 * platform's, not a log line, and `/oauth2/callback?code=` is supposed to be
 * there. A finding names the event and the kind of data, never the value, so
 * the report itself is safe to paste. Exits 1 when anything is found.
 *
 * The capture file holds whatever production sent; delete it when done.
 */

import { readFileSync } from "node:fs";

/** What must never appear in a log line, by name. */
export const PATTERNS = {
  email: /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i,
  "bearer token": /bearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  "device token": /\bsyd_[A-Za-z0-9_-]{8,}/,
  "Stripe key": /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/,
  "provider key": /\bsk-ant-[A-Za-z0-9_-]{8,}|\bgsk_[A-Za-z0-9]{8,}|\bsk-(proj-)?[A-Za-z0-9]{20,}/,
  "Google token": /\bya29\.[A-Za-z0-9_-]{8,}|\b1\/\/[A-Za-z0-9_-]{8,}/,
  "query string": /[?&](code|token|state|t)=[^&\s"]{4,}/,
};

/** Every JSON object in a capture, in order. wrangler writes them back to back. */
export function events(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A half-written last event when the tail was killed: skip it.
        }
      }
    }
  }
  return out;
}

/** What the Worker itself wrote in one event, as strings. */
function written(event) {
  const lines = (event.logs ?? []).map((l) => (typeof l.message === "string" ? l.message : JSON.stringify(l.message)));
  const errors = (event.exceptions ?? []).map((e) => `${e.name ?? ""}: ${e.message ?? ""}`);
  return [...lines, ...errors];
}

/** The scan, pure so it can be tested: counts, and each finding without its value. */
export function scan(text) {
  const all = events(text);
  const findings = [];
  let lines = 0;
  all.forEach((event, index) => {
    for (const line of written(event)) {
      lines++;
      for (const [kind, pattern] of Object.entries(PATTERNS)) {
        if (pattern.test(line)) findings.push({ event: index, kind });
      }
    }
  });
  return { events: all.length, lines, findings };
}

export function report({ events, lines, findings }) {
  const head = `${events} events, ${lines} log lines`;
  if (lines === 0) return `${head}. Nothing was logged, so this proves little; capture a session that does real work.`;
  if (!findings.length) return `${head}. No personal data or secrets found.`;
  return [
    `${head}. ${findings.length} finding(s):`,
    ...findings.map((f) => `  event ${f.event}: ${f.kind}`),
    "Look at those events in the capture, fix the log call in src/, and add the case to test/logs.test.ts.",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/scan-logs.mjs <capture from wrangler tail --format json>");
    process.exit(2);
  }
  const result = scan(readFileSync(file, "utf8"));
  console.log(report(result));
  process.exit(result.findings.length ? 1 : 0);
}
