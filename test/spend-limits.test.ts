/**
 * The study assistant's spending limits, under requests that arrive together.
 *
 * assistant.test.ts shows each limit holding for one request after another.
 * These send the requests at once, which is what a modified Mac (or a script
 * holding its token) would do to get past a check that reads a count and
 * then writes one. Every limit here is meant to be a single statement that
 * cannot be split, so exactly as many requests get through as there is room
 * for, and the provider is called only for those.
 *
 * Nothing leaves the test: the provider is a stub, the keys are test keys,
 * and the costs are rows in a throwaway D1.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { ASSISTANT_CEILING, SESSION_COST_CAP, SESSION_QUESTIONS } from "../src/assistant";
import { claimDevice, freezeClockJustBeforeAWindowEnds, postJson } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const bearer = (token: string) => ({ Authorization: "Bearer " + token });

/**
 * D1 with the latency a real one has.
 *
 * The test D1 answers so fast that the first of several requests sent
 * together reaches the provider before the second has read anything, which
 * would let a check-then-write pass every race here by luck. A random pause
 * before each statement lets the requests interleave the way they do in
 * production, so a limit that is not one statement shows up as a failure.
 */
function withLatency() {
  const proto = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const originals: [string, (...a: unknown[]) => unknown][] = [];
  for (const name of ["first", "run", "all", "raw"]) {
    const original = proto[name];
    originals.push([name, original]);
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      await new Promise((r) => setTimeout(r, Math.random() * 6));
      return original.apply(this, args);
    };
  }
  return () => {
    for (const [name, original] of originals) proto[name] = original;
  };
}

let restoreLatency: (() => void) | null = null;
beforeEach(() => {
  restoreLatency = withLatency();
});
afterEach(() => {
  restoreLatency?.();
  restoreLatency = null;
});

/**
 * A summary big enough that the question's estimate is about 107,000
 * micro-USD: 80,000 for the output cap plus 40,000 characters at the
 * cache-write rate, plus the system prompt. "Room for one" below is 160,000,
 * which fits one such estimate and never two.
 */
const SUMMARIES = [{ title: "ACCT-4321 2026-09-15: Job Order Costing", context: "Summary.", body: "Jobs carry costs. ".repeat(2_223) }];
const ROOM_FOR_ONE = 160_000;

async function pro(accountId: string, sessions = 15) {
  await db.putAllowance(env.DB, accountId, {
    audio_seconds: 45 * 3600,
    summary_tokens: 1_350_000,
    assistant_sessions: sessions,
    source: "pro",
  });
}

async function proMac(tag: string, sessions = 15) {
  const mac = await claimDevice(`${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await pro(mac.account.id, sessions);
  return mac;
}

function sse(events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function answered(usage = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, outputTokens = 400) {
  return sse([
    { type: "message_start", message: { id: "msg_1", usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "An answer." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } },
    { type: "message_stop" },
  ]);
}

/**
 * The provider, answering after a short pause so that requests sent together
 * are all in flight at once. Counts the calls it was asked to make.
 */
function provider(answer: () => Response = () => answered()) {
  const calls = { n: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls.n += 1;
      await new Promise((r) => setTimeout(r, 25));
      return answer();
    }),
  );
  return calls;
}

function ask(token: string, extra: Record<string, unknown> = {}) {
  return postJson("/proxy/assistant", { question: "What is job order costing?", summaries: SUMMARIES, ...extra }, bearer(token));
}

/** Send `n` at once; read each streamed body to the end so its bill settles. */
async function together(n: number, send: () => Promise<Response>) {
  const responses = await Promise.all(Array.from({ length: n }, send));
  const bodies = await Promise.all(responses.map((r) => r.text()));
  return responses.map((r, i) => ({ status: r.status, body: bodies[i] }));
}

const ok = (results: { status: number }[]) => results.filter((r) => r.status === 200).length;

function sessionIdIn(body: string): string {
  const event = body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)))
    .find((e) => e.type === "session");
  return event.id;
}

async function sessionRow(id: string) {
  return env.DB.prepare("SELECT questions, escalations, spent FROM assistant_sessions WHERE id = ?")
    .bind(id)
    .first<{ questions: number; escalations: number; spent: number }>();
}

async function spentThisMonth(accountId: string) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(units), 0) AS n FROM usage WHERE account_id = ? AND kind = 'assistant' AND period = ?")
    .bind(accountId, db.usagePeriod())
    .first<{ n: number }>();
  return row!.n;
}

describe("sessions opened together", () => {
  it("open no more than the month has left", async () => {
    const mac = await proMac("open-race", 2);
    const calls = provider();
    const results = await together(6, () => ask(mac.token));

    expect(ok(results)).toBe(2);
    expect(calls.n).toBe(2);
    expect(await db.assistantSessionsThisPeriod(env.DB, mac.account.id)).toBe(2);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(JSON.parse(r.body)).toMatchObject({ error: "allowance_exhausted", unit: "sessions" });
    }
  });

  it("open none for a plan without sessions, however many are sent", async () => {
    const mac = await proMac("open-race-zero", 0);
    const calls = provider();
    const results = await together(5, () => ask(mac.token));
    expect(ok(results)).toBe(0);
    expect(calls.n).toBe(0);
    expect(await spentThisMonth(mac.account.id)).toBe(0);
  });
});

describe("follow-ups sent together", () => {
  it("take no more questions than the session has left", async () => {
    const mac = await proMac("question-race");
    provider();
    const first = await together(1, () => ask(mac.token));
    const id = sessionIdIn(first[0].body);
    await env.DB.prepare("UPDATE assistant_sessions SET questions = ? WHERE id = ?").bind(SESSION_QUESTIONS - 1, id).run();

    const calls = provider();
    const results = await together(5, () => ask(mac.token, { session_id: id }));
    expect(ok(results)).toBe(1);
    expect(calls.n).toBe(1);
    expect((await sessionRow(id))!.questions).toBe(SESSION_QUESTIONS);
  });

  it("spend no further past the session's cap than it has room for", async () => {
    const mac = await proMac("cost-race");
    provider();
    const id = sessionIdIn((await together(1, () => ask(mac.token)))[0].body);
    await env.DB.prepare("UPDATE assistant_sessions SET spent = ? WHERE id = ?").bind(SESSION_COST_CAP - ROOM_FOR_ONE, id).run();

    const calls = provider();
    const results = await together(4, () => ask(mac.token, { session_id: id }));
    expect(ok(results)).toBe(1);
    expect(calls.n).toBe(1);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(JSON.parse(r.body)).toEqual({ error: "session_ended", reason: "cost" });
    }
    expect((await sessionRow(id))!.spent).toBeLessThanOrEqual(SESSION_COST_CAP);
  });

  it("go to the transcripts once per question, not once per request", async () => {
    const mac = await proMac("escalation-race");
    provider();
    const id = sessionIdIn((await together(1, () => ask(mac.token)))[0].body);

    const calls = provider();
    const continuation = [
      { type: "text", text: "Let me check the lecture." },
      { type: "tool_use", id: "toolu_1", name: "fetch_transcripts", input: { lectures: ["ACCT-4321 2026-09-15: Job Order Costing"] } },
    ];
    const results = await together(4, () =>
      ask(mac.token, { session_id: id, continuation, transcripts: [{ title: "t", context: "c", body: "b" }] }),
    );
    expect(ok(results)).toBe(1);
    expect(calls.n).toBe(1);
    expect((await sessionRow(id))!.escalations).toBe(1);
  });
});

describe("the month's dollars", () => {
  it("are held before the call, so requests sent together cannot all fit", async () => {
    // The month holds four sessions' caps in dollars (src/assistant.ts), and
    // calls already billed have spent all but room for one more question.
    const mac = await proMac("month-race", 4);
    await db.recordUsage(env.DB, mac.account.id, mac.deviceId, "assistant", 4 * SESSION_COST_CAP - ROOM_FOR_ONE);

    const calls = provider();
    const results = await together(4, () => ask(mac.token));
    expect(ok(results)).toBe(1);
    expect(calls.n).toBe(1);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(JSON.parse(r.body)).toMatchObject({ error: "allowance_exhausted", unit: "dollars" });
    }
    // Sessions refused for dollars are given back rather than counted.
    expect(await db.assistantSessionsThisPeriod(env.DB, mac.account.id)).toBe(1);
  });

  it("refuse the next question once a call came in over its estimate", async () => {
    // The estimate reads four characters to the token. Text that tokenizes
    // denser (digits, or anything but English) can cost more than was held,
    // and the overrun is real money already spent. What must hold is that
    // nothing more is spent after it.
    const mac = await proMac("overrun");
    provider(() => answered({ input_tokens: 0, cache_creation_input_tokens: 900_000, cache_read_input_tokens: 0, output_tokens: 1 }, 1));
    const id = sessionIdIn((await together(1, () => ask(mac.token)))[0].body);
    expect((await sessionRow(id))!.spent).toBeGreaterThan(SESSION_COST_CAP);

    const calls = provider();
    const next = await together(3, () => ask(mac.token, { session_id: id }));
    expect(ok(next)).toBe(0);
    expect(calls.n).toBe(0);
  });
});

describe("one account sending as fast as it can", () => {
  it("reaches the provider no more than the per-minute limit allows", async () => {
    freezeClockJustBeforeAWindowEnds();
    const mac = await proMac("rate-race");
    const calls = provider();
    const results = await together(14, () => ask(mac.token));
    expect(ok(results)).toBe(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(calls.n).toBe(10);
  });
});

describe("the ceiling across every account", () => {
  let filler: string | null = null;

  afterEach(async () => {
    if (filler) await env.DB.prepare("DELETE FROM usage WHERE account_id = ?").bind(filler).run();
    filler = null;
  });

  /** Somebody else's billed calls, filling the month's ceiling to within `room`. */
  async function fillCeilingTo(room: number) {
    const someone = await claimDevice(`ceiling-filler-${crypto.randomUUID().slice(0, 8)}@example.com`);
    filler = someone.account.id;
    const used = await db.usedGlobally(env.DB, "assistant");
    await db.recordUsage(env.DB, someone.account.id, someone.deviceId, "assistant", ASSISTANT_CEILING - room - used);
  }

  it("refuses everybody, before the provider, once it is reached", async () => {
    await fillCeilingTo(0);
    const mac = await proMac("ceiling-full");
    const calls = provider();
    const [res] = await together(1, () => ask(mac.token));
    expect(res.status).toBe(402);
    expect(JSON.parse(res.body)).toMatchObject({ error: "service_ceiling", kind: "assistant" });
    expect(calls.n).toBe(0);
    expect(await db.assistantSessionsThisPeriod(env.DB, mac.account.id)).toBe(0);
  });

  it("lets through no more than it has room for when many accounts ask at once", async () => {
    const macs = await Promise.all([1, 2, 3, 4].map((i) => proMac(`ceiling-race-${i}`)));
    await fillCeilingTo(ROOM_FOR_ONE);
    const calls = provider();
    let i = 0;
    const results = await together(4, () => ask(macs[i++].token));
    expect(ok(results)).toBe(1);
    expect(calls.n).toBe(1);
  });
});

describe("a reservation against the ceiling", () => {
  // The same statement holds the transcription and summary ceilings
  // (src/proxy.ts), so this covers those routes as well as the assistant.
  it("is taken by no more accounts at once than it has room for", async () => {
    const macs = await Promise.all([1, 2, 3, 4, 5].map((i) => claimDevice(`reserve-race-${i}-${crypto.randomUUID().slice(0, 8)}@example.com`)));
    const used = await db.usedGlobally(env.DB, "summarize");
    const ceiling = used + 25_000;
    const held = await Promise.all(macs.map((m) => db.reserveUsage(env.DB, m.account.id, m.deviceId, "summarize", 10_000, 1_000_000, ceiling)));
    expect(held.filter(Boolean)).toHaveLength(2);
    expect(await db.usedGlobally(env.DB, "summarize")).toBeLessThanOrEqual(ceiling);
  });
});
