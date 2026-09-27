// Every test in the suite doubles as a check on what the Worker logs.
//
// Worker logs are kept by Cloudflare and readable from the dashboard, so they
// name an account by its id and nothing else (src/log.ts). This setup file
// records every console line written while a test runs, the Worker's and the
// Durable Object's included (they run in this isolate), and fails the test if
// one carries an email address, a secret binding, a device token, a Google
// token, or a line src/log.ts had to scrub. The suite already walks sign-in,
// a refused panel viewer, device approval, the Stripe webhook and Drive
// connect and disconnect with real-looking addresses, so a new log line that
// names a person fails wherever that flow is tested.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, vi } from "vitest";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RAW = [EMAIL, /\bsyd_\w+/, /ya29\.\w/, /1\/\/[\w-]/];
// What src/log.ts leaves where it took something out. The Worker's own lines
// should never need it, so seeing it means a line was written with a person
// or a secret in it; a test of text quoted back by Google or Stripe says so
// with allowScrubbedLines().
const SCRUBBED = /\[(?:email|secret)\]|\?\[query\]/;
const SECRETS = [
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "DRIVE_KEY",
  "DRIVE_KEY_PREVIOUS",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "ANTHROPIC_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
] as const;

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
// Taken once, before any spy, so that a spy never ends up calling itself.
const ORIGINAL = Object.fromEntries(METHODS.map((m) => [m, console[m].bind(console)])) as Record<(typeof METHODS)[number], (...args: unknown[]) => void>;
let lines: string[] = [];
let scrubbedAllowed = false;
let spies: { mockRestore(): void }[] = [];

/** What the current test has logged so far, one entry per console call. */
export function loggedLines(): string[] {
  return [...lines];
}

/** This test feeds the Worker third-party text that src/log.ts must scrub. */
export function allowScrubbedLines(): void {
  scrubbedAllowed = true;
}

beforeEach(() => {
  lines = [];
  scrubbedAllowed = false;
  for (const method of METHODS) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      ORIGINAL[method](...args);
    });
    spies.push(spy);
  }
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  const secrets = SECRETS.map((name) => String(env[name] ?? "")).filter(Boolean);
  const bad = lines.filter((line) => RAW.some((re) => re.test(line)) || (!scrubbedAllowed && SCRUBBED.test(line)) || secrets.some((s) => line.includes(s)));
  expect(bad, "a log line carries personal data or a secret; name the account by its id").toEqual([]);
});
