/**
 * The study assistant, on the service's key.
 *
 *   POST /proxy/assistant   (device bearer) a question about one course -> an SSE stream
 *
 * Until this route the assistant ran on the Mac's own ANTHROPIC_API_KEY
 * (LectureAI intake/assistant.py), so it worked for whoever had pasted one in
 * and for nobody else. Pro is sold as 45 hours plus 15 study sessions, and a
 * session nobody can open without a key of their own is not something that
 * can be sold. Here the key is a Worker secret like the other two, and the
 * sessions are counted where the Mac cannot change the count.
 *
 * The Mac still does the reading. The lectures live in the student's Drive
 * under the drive.file scope, and pipeline.log on the Mac is the index of
 * them, so the Mac sends the summaries it read and this service never touches
 * Drive for the assistant. What this service fixes, as /proxy/summarize does,
 * is everything about the upstream call a caller could otherwise turn into a
 * general-purpose model at our expense: the model, the system prompt, the one
 * tool, the output cap, and how the documents are framed. A caller sends
 * documents and a question, and that is all.
 *
 * Two stages, exactly as on the Mac, because Pro's margin rests on them:
 *
 *   1. The summaries for a course, cached, and the question. The model may
 *      answer, or call fetch_transcripts to ask for specific lectures.
 *   2. When it asks, this stream ends with an `escalate` event carrying what
 *      it asked for and the assistant turn so far. The Mac reads those
 *      transcripts from Drive and posts again with `continuation` and
 *      `transcripts`. The second call runs with tool_choice "none", so a
 *      question escalates at most once, and each session row counts it.
 *
 * The service is stateless between the two calls on purpose: nothing a
 * student asks or reads is stored here, only counts and a dollar figure. The
 * cost of that is the continuation making a round trip through the Mac, which
 * is harmless. Its thinking blocks are signed by the provider, and anything
 * else in it the Mac could have written into the question anyway.
 *
 * What bounds the spend:
 *
 *   1. Sessions. Opening one is the charge against allowances.assistant_sessions
 *      and happens in one statement with the count (the reservation pattern of
 *      migrations/0007). No tier but Pro includes any, and neither does the
 *      trial.
 *   2. Inside a session: SESSION_QUESTIONS questions within SESSION_MINUTES,
 *      at most one escalation per question, and SESSION_COST_CAP dollars. Each
 *      call reserves its estimate against the cap before it runs and is
 *      settled to what the provider reports afterwards.
 *   3. The per-account rate limit and the global ceiling, as on every other
 *      paid route.
 *   4. Hard caps on every field of the request, refused before anything is
 *      forwarded.
 *
 * Spend is metered in millionths of a dollar, not tokens. A session mixes
 * cache writes, cache reads that cost a tenth as much, and output that costs
 * five times as much, so a token count would say nothing about the bill. The
 * rates are Sonnet 5's and live beside the model constant, so changing one
 * without the other is a visible diff.
 */

import { Hono, type Context } from "hono";
import * as db from "./db";
import type { AppEnv } from "./env";
import { allowanceFor, boundedBody, isRefusal, label, providerFailed, refuse, type Refusal } from "./proxy";
import { now, randomId } from "./util";

// --- What is fixed here, and not by a caller --------------------------------

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Sonnet 5, not Opus. HOME-STRETCH costed a Pro month of 15 sessions at $3.96
 * on Sonnet and $9.90 on Opus, and the published $25 price is a 53% margin on
 * the first and 29% on the second. LectureAI pins the same model in
 * config.ASSISTANT_MODEL with a test; the two should move together.
 */
export const ASSISTANT_MODEL = "claude-sonnet-5";

/**
 * Sonnet 5's rates, per token, in millionths of a dollar: $2 and $10 per
 * million in and out, a 5-minute cache write at 1.25x the input rate, and a
 * cache read at 0.1x.
 */
export const RATES = { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 } as const;

/** Room for a study guide across several lectures, as on the Mac. */
const MAX_OUTPUT_TOKENS = 8000;

/**
 * Thinking is off for now, and said so explicitly: Sonnet 5 thinks
 * adaptively when the request leaves `thinking` out, thinking tokens bill as
 * output and count against MAX_OUTPUT_TOKENS, and neither the HOME-STRETCH
 * session price nor estimateOf() was costed with them.
 *
 * To turn it on, set this to "adaptive" (the only on-mode Sonnet 5 accepts;
 * budget_tokens is refused with a 400) and re-cost first: raise
 * MAX_OUTPUT_TOKENS so thinking does not crowd out the answer, then check
 * SESSION_COST_CAP and the Pro session price against a few real sessions'
 * `output_tokens`. Everything else is already in place: the stream parser
 * keeps thinking and redacted_thinking blocks with their signatures, and a
 * continuation hands them back unchanged, as the API requires.
 */
export const ASSISTANT_THINKING: "disabled" | "adaptive" = "disabled";

/** The request's `thinking` field for a mode. "omitted" display: the panel never shows reasoning. */
export function thinkingParam(mode: "disabled" | "adaptive" = ASSISTANT_THINKING) {
  return mode === "adaptive" ? ({ type: "adaptive", display: "omitted" } as const) : ({ type: "disabled" } as const);
}

const FETCH_TOOL_NAME = "fetch_transcripts";

/** At most this many transcripts on one escalation, as on the Mac. */
const MAX_ESCALATION_LECTURES = 6;

/**
 * Copied from LectureAI intake/assistant.py, where the BYO-key path still uses
 * its own copy. Changes to either should be made to both.
 */
const SYSTEM_PROMPT = `You are the study assistant inside Syllabus, a tool that records a student's lectures, transcribes them, and files a summary of each one.

You are given the summaries of the lectures in one course. Answer the student's question from them. These are the student's own classes, so be specific: name the lecture and the date a point came from rather than speaking generally.

The summaries are condensed. When the question needs something a summary does not carry, the exact wording of a definition, an example worked in class, what the instructor said about an exam, call the fetch_transcripts tool with the lectures you need and say why. Do not call it when the summaries already answer the question; a transcript is thirty times the length of a summary and the student pays for it either way.

Cite the lecture you are drawing on. Write plainly, in the second person, and never pad. If the lectures do not cover what was asked, say so rather than filling the gap from general knowledge, and say what they do cover instead.`;

const FETCH_TOOL = {
  name: FETCH_TOOL_NAME,
  description:
    "Fetch the full verbatim transcript of specific lectures, when their summaries are not enough to answer. " +
    "Ask only for the lectures you actually need.",
  input_schema: {
    type: "object",
    properties: {
      lectures: {
        type: "array",
        items: { type: "string" },
        description: `Lecture names exactly as given in the document titles, at most ${MAX_ESCALATION_LECTURES}.`,
      },
      reason: { type: "string", description: "Why the summaries are not sufficient here." },
    },
    required: ["lectures", "reason"],
  },
};

/** What the model is handed when the Mac could not read any of the transcripts. */
const NO_TRANSCRIPTS =
  "Those transcripts could not be retrieved. Answer from the summaries you already have, " +
  "and say that the verbatim wording was not available.";

// --- Limits -----------------------------------------------------------------

/**
 * One session: the first question and the follow-ups HOME-STRETCH prices it
 * on (eight), with slack, inside an hour. The 5-minute cache stays warm across
 * a real sitting because each read refreshes it, so an hour is a generous
 * sitting rather than a cache limit.
 */
export const SESSION_QUESTIONS = 12;
export const SESSION_MINUTES = 60;

/**
 * What one session may cost, in millionths of a dollar.
 *
 * The heaviest modeled session, a whole course with transcripts, is $1.05 on
 * Sonnet 5. Two dollars is that with room, and it is what bounds a session
 * somebody is using as a free chat box rather than a study sitting. Fifteen
 * of them at the cap is $30, which is the worst Pro month and is only reached
 * by trying.
 */
export const SESSION_COST_CAP = 2_000_000;

/** What the assistant may cost across every account in a month: $500. */
export const ASSISTANT_CEILING = 500_000_000;

const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT = 10;

const MAX_BODY_BYTES = 1536 * 1024;
const MAX_QUESTION_CHARS = 4000;
/** A course of summaries is about 15k tokens; this is several times that. */
const MAX_SUMMARY_CHARS = 300_000;
const MAX_SUMMARIES = 120;
/** The Mac's own cap on one escalation (intake/assistant.py). */
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TITLE_CHARS = 200;
const MAX_CONTEXT_CHARS = 300;
const MAX_CONTINUATION_BLOCKS = 16;
const MAX_CONTINUATION_CHARS = 200_000;

// --- Sessions ---------------------------------------------------------------

type SessionRow = {
  id: string;
  account_id: string;
  device_id: string;
  period: string;
  opened_at: string;
  questions: number;
  escalations: number;
  spent: number;
};

function sessionCutoff(): string {
  return new Date(Date.now() - SESSION_MINUTES * 60 * 1000).toISOString();
}

/**
 * Open a session, or refuse because the month's are spent. One statement, so
 * the count and the insert cannot be split by a second request.
 */
async function openSession(database: D1Database, accountId: string, deviceId: string, allowed: number) {
  const period = db.usagePeriod();
  return database
    .prepare(
      `INSERT INTO assistant_sessions (id, account_id, device_id, period, opened_at)
       SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM assistant_sessions WHERE account_id = ? AND period = ?) < ?
       RETURNING id`,
    )
    .bind(randomId(12), accountId, deviceId, period, now(), accountId, period, allowed)
    .first<{ id: string }>();
}

/**
 * Take one question out of a session and hold its estimate against the cap.
 * Null when the session is not this account's, is over, or cannot afford it.
 */
async function takeQuestion(database: D1Database, id: string, accountId: string, estimate: number) {
  return database
    .prepare(
      `UPDATE assistant_sessions SET questions = questions + 1, spent = spent + ?
        WHERE id = ? AND account_id = ? AND opened_at > ? AND questions < ? AND spent + ? <= ?
       RETURNING questions, spent`,
    )
    .bind(estimate, id, accountId, sessionCutoff(), SESSION_QUESTIONS, estimate, SESSION_COST_CAP)
    .first<{ questions: number; spent: number }>();
}

/**
 * Take one escalation, which is only ever owed to a question already asked.
 *
 * Not held to the session's hour: a question asked at minute 59 may still
 * need its transcripts at minute 61, and escalations < questions already
 * stops this being a way to keep a session going.
 */
async function takeEscalation(database: D1Database, id: string, accountId: string, estimate: number) {
  return database
    .prepare(
      `UPDATE assistant_sessions SET escalations = escalations + 1, spent = spent + ?
        WHERE id = ? AND account_id = ? AND escalations < questions AND spent + ? <= ?
       RETURNING questions, spent`,
    )
    .bind(estimate, id, accountId, estimate, SESSION_COST_CAP)
    .first<{ questions: number; spent: number }>();
}

/** Correct a held estimate to what the call actually cost. */
async function settleSession(database: D1Database, id: string, delta: number) {
  await database.prepare("UPDATE assistant_sessions SET spent = MAX(0, spent + ?) WHERE id = ?").bind(delta, id).run();
}

/**
 * Give back a question or escalation whose call never happened. A session
 * that was opened by this very request, and so has nothing else in it, is
 * deleted outright: a student is not charged a session for a provider outage.
 */
async function undoTake(database: D1Database, id: string, estimate: number, escalation: boolean, opened: boolean) {
  if (opened) {
    await database.prepare("DELETE FROM assistant_sessions WHERE id = ? AND questions <= 1").bind(id).run();
    return;
  }
  const column = escalation ? "escalations" : "questions";
  await database
    .prepare(`UPDATE assistant_sessions SET ${column} = MAX(0, ${column} - 1), spent = MAX(0, spent - ?) WHERE id = ?`)
    .bind(estimate, id)
    .run();
}

async function sessionById(database: D1Database, id: string, accountId: string) {
  return database
    .prepare("SELECT * FROM assistant_sessions WHERE id = ? AND account_id = ?")
    .bind(id, accountId)
    .first<SessionRow>();
}

/** Why a session would not take another question, in the terms the Mac acts on. */
function sessionEnded(row: SessionRow | null, estimate: number): Refusal {
  let reason = "unknown_session";
  if (row) {
    if (row.opened_at <= sessionCutoff()) reason = "expired";
    else if (row.questions >= SESSION_QUESTIONS) reason = "questions";
    else if (row.spent + estimate > SESSION_COST_CAP) reason = "cost";
  }
  // 409 rather than 402: the month may have plenty left, and the answer to
  // this is to open a new session, which the Mac does by leaving the id out.
  return { status: 409, body: { error: "session_ended", reason } };
}

// --- Cost -------------------------------------------------------------------

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export function costOf(u: Usage): number {
  return Math.ceil(
    u.input_tokens * RATES.input +
      u.output_tokens * RATES.output +
      u.cache_write_tokens * RATES.cache_write +
      u.cache_read_tokens * RATES.cache_read,
  );
}

/**
 * What a call is held at before it runs: every input character priced as a
 * cache write (the most an input token can cost), four characters to the
 * token, and the full output cap. It is always high, which is the direction
 * that keeps two concurrent calls from spending past the cap together.
 */
export function estimateOf(inputChars: number): number {
  return Math.ceil((inputChars / 4) * RATES.cache_write + MAX_OUTPUT_TOKENS * RATES.output);
}

// --- The request ------------------------------------------------------------

type Doc = { title: string; context: string; body: string };

type ContinuationBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: { lectures: string[]; reason: string } };

type Asked = {
  sessionId: string;
  question: string;
  summaries: Doc[];
  continuation: ContinuationBlock[] | null;
  transcripts: Doc[];
};

function bad(detail: string): Refusal {
  return { status: 400, body: { error: "bad_request", detail } };
}

function text(raw: unknown, cap: number): string {
  return typeof raw === "string" ? raw.slice(0, cap) : "";
}

function docs(raw: unknown, maxCount: number, maxChars: number, what: string): Doc[] | Refusal {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return bad(`${what} must be a list`);
  if (raw.length > maxCount) return { status: 413, body: { error: "too_large", field: what, limit_count: maxCount } };
  const out: Doc[] = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return bad(`every ${what} entry must be an object`);
    const entry = item as Record<string, unknown>;
    const body = typeof entry.body === "string" ? entry.body : "";
    if (!body.trim()) continue;
    total += body.length;
    if (total > maxChars) return { status: 413, body: { error: "too_large", field: what, limit_chars: maxChars } };
    out.push({
      title: label(text(entry.title, MAX_TITLE_CHARS * 2)).slice(0, MAX_TITLE_CHARS) || "Untitled lecture",
      context: label(text(entry.context, MAX_CONTEXT_CHARS * 2)).slice(0, MAX_CONTEXT_CHARS),
      body,
    });
  }
  return out;
}

/**
 * The assistant turn the Mac hands back, rebuilt field by field.
 *
 * Only the four block types a stage-one answer can contain are accepted, and
 * exactly one of them must be the fetch_transcripts call being answered. It
 * is rebuilt rather than forwarded so that no field the API would read, such
 * as cache_control or a second tool, can ride along.
 */
function continuation(raw: unknown): ContinuationBlock[] | Refusal {
  if (!Array.isArray(raw) || raw.length === 0) return bad("continuation must be a non-empty list");
  if (raw.length > MAX_CONTINUATION_BLOCKS) return bad("continuation has too many blocks");
  const out: ContinuationBlock[] = [];
  let chars = 0;
  let calls = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return bad("continuation blocks must be objects");
    const b = item as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      chars += b.text.length;
      out.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && typeof b.thinking === "string" && typeof b.signature === "string") {
      chars += b.thinking.length + b.signature.length;
      out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "redacted_thinking" && typeof b.data === "string") {
      chars += b.data.length;
      out.push({ type: "redacted_thinking", data: b.data });
    } else if (b.type === "tool_use" && b.name === FETCH_TOOL_NAME && typeof b.id === "string") {
      calls += 1;
      const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
      const lectures = Array.isArray(input.lectures)
        ? input.lectures.filter((l): l is string => typeof l === "string").slice(0, MAX_ESCALATION_LECTURES)
            .map((l) => l.slice(0, MAX_TITLE_CHARS))
        : [];
      out.push({
        type: "tool_use",
        id: b.id.slice(0, 200),
        name: FETCH_TOOL_NAME,
        input: { lectures, reason: text(input.reason, 1000) },
      });
    } else {
      return bad("continuation carries a block this route does not accept");
    }
  }
  if (calls !== 1) return bad("continuation must carry exactly one fetch_transcripts call");
  if (chars > MAX_CONTINUATION_CHARS) return { status: 413, body: { error: "too_large", field: "continuation" } };
  return out;
}

function parse(raw: Uint8Array): Asked | Refusal {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return bad("expected a JSON object");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("expected a JSON object");

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return bad("question is empty");
  if (question.length > MAX_QUESTION_CHARS) {
    return { status: 413, body: { error: "too_large", field: "question", limit_chars: MAX_QUESTION_CHARS } };
  }
  const summaries = docs(body.summaries, MAX_SUMMARIES, MAX_SUMMARY_CHARS, "summaries");
  if (!Array.isArray(summaries)) return summaries;
  if (summaries.length === 0) return bad("no summaries to answer from");

  const sessionId = typeof body.session_id === "string" ? body.session_id.slice(0, 64) : "";
  let cont: ContinuationBlock[] | null = null;
  let transcripts: Doc[] = [];
  if (body.continuation !== undefined && body.continuation !== null) {
    if (!sessionId) return bad("a continuation belongs to a session; session_id is missing");
    const c = continuation(body.continuation);
    if (!Array.isArray(c)) return c;
    cont = c;
    const t = docs(body.transcripts, MAX_ESCALATION_LECTURES, MAX_TRANSCRIPT_CHARS, "transcripts");
    if (!Array.isArray(t)) return t;
    transcripts = t;
  }
  return { sessionId, question, summaries, continuation: cont, transcripts };
}

function documentBlock(doc: Doc, cache: boolean) {
  return {
    type: "document",
    title: doc.title,
    ...(doc.context ? { context: doc.context } : {}),
    source: { type: "text", media_type: "text/plain", data: doc.body },
    citations: { enabled: true },
    ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
  };
}

/**
 * The upstream request, built entirely here.
 *
 * The tools and system prompt are identical on both stages, and the summaries
 * come first with the cache breakpoint on the last of them, so the second
 * stage and every follow-up question in a session read the course from cache.
 * Stage two differs only in what follows the breakpoint and in tool_choice,
 * which is what stops a second escalation.
 */
function upstreamBody(asked: Asked) {
  const summaries = asked.summaries.map((d, i) => documentBlock(d, i === asked.summaries.length - 1));
  const messages: unknown[] = [{ role: "user", content: [...summaries, { type: "text", text: asked.question }] }];
  if (asked.continuation) {
    const call = asked.continuation.find((b) => b.type === "tool_use") as Extract<ContinuationBlock, { type: "tool_use" }>;
    messages.push({ role: "assistant", content: asked.continuation });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: call.id,
          content: asked.transcripts.length
            ? asked.transcripts.map((d) => documentBlock(d, false))
            : [{ type: "text", text: NO_TRANSCRIPTS }],
        },
      ],
    });
  }
  return {
    model: ASSISTANT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: thinkingParam(),
    stream: true,
    system: SYSTEM_PROMPT,
    tools: [FETCH_TOOL],
    tool_choice: { type: asked.continuation ? "none" : "auto" },
    messages,
  };
}

function inputChars(asked: Asked): number {
  const docsChars = (list: Doc[]) => list.reduce((n, d) => n + d.body.length + d.title.length + d.context.length, 0);
  const cont = asked.continuation ? JSON.stringify(asked.continuation).length : 0;
  return SYSTEM_PROMPT.length + asked.question.length + docsChars(asked.summaries) + docsChars(asked.transcripts) + cont;
}

// --- The stream -------------------------------------------------------------

/**
 * One SSE event from the provider, read into what this route passes on.
 *
 * The provider's own events are never forwarded. What the Mac receives is a
 * smaller vocabulary of this route's making: text as it is written, each
 * lecture the answer cites (once), and, at the end, either an escalation to
 * act on or the usage and cost of the call.
 */
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; json: string }
  | { type: "other" };

type Outcome = {
  usage: Usage;
  stopReason: string;
  blocks: Block[];
  failed: boolean;
};

async function relayStream(
  upstream: ReadableStream<Uint8Array>,
  emit: (event: Record<string, unknown>) => Promise<boolean>,
): Promise<Outcome> {
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const blocks: Block[] = [];
  const cited = new Set<string>();
  let stopReason = "";
  let failed = false;

  const takeUsage = (u: Record<string, unknown> | undefined) => {
    if (!u) return;
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : null);
    // message_delta repeats the counts cumulatively, so the larger is right.
    usage.input_tokens = Math.max(usage.input_tokens, n("input_tokens") ?? 0);
    usage.output_tokens = Math.max(usage.output_tokens, n("output_tokens") ?? 0);
    usage.cache_read_tokens = Math.max(usage.cache_read_tokens, n("cache_read_input_tokens") ?? 0);
    usage.cache_write_tokens = Math.max(usage.cache_write_tokens, n("cache_creation_input_tokens") ?? 0);
  };

  const reader = upstream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let listening = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case "message_start":
            takeUsage(ev.message?.usage);
            break;
          case "content_block_start": {
            const cb = ev.content_block ?? {};
            const i = Number(ev.index);
            if (cb.type === "text") blocks[i] = { type: "text", text: cb.text ?? "" };
            else if (cb.type === "thinking") blocks[i] = { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature ?? "" };
            else if (cb.type === "redacted_thinking") blocks[i] = { type: "redacted_thinking", data: cb.data ?? "" };
            else if (cb.type === "tool_use") blocks[i] = { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", json: "" };
            else blocks[i] = { type: "other" };
            break;
          }
          case "content_block_delta": {
            const d = ev.delta ?? {};
            const b = blocks[Number(ev.index)];
            if (d.type === "text_delta" && b?.type === "text") {
              b.text += d.text ?? "";
              if (listening) listening = await emit({ type: "text", text: d.text ?? "" });
            } else if (d.type === "citations_delta") {
              const title = String(d.citation?.document_title ?? "");
              if (title && !cited.has(title)) {
                cited.add(title);
                if (listening) listening = await emit({ type: "citation", title });
              }
            } else if (d.type === "input_json_delta" && b?.type === "tool_use") {
              b.json += d.partial_json ?? "";
            } else if (d.type === "thinking_delta" && b?.type === "thinking") {
              b.thinking += d.thinking ?? "";
            } else if (d.type === "signature_delta" && b?.type === "thinking") {
              b.signature = d.signature ?? b.signature;
            }
            break;
          }
          case "message_delta":
            stopReason = String(ev.delta?.stop_reason ?? stopReason);
            takeUsage(ev.usage);
            break;
          case "error":
            console.log(`assistant: the provider stream failed (${ev.error?.type ?? "unknown"})`);
            failed = true;
            break;
        }
      }
      // Somebody who closed the panel is not owed the rest of an answer, and
      // every further token is billed. Stop reading and the provider stops.
      if (!listening || failed) break;
    }
  } catch {
    failed = true;
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!listening) failed = true;
  return { usage, stopReason, blocks, failed };
}

/** The assistant turn so far, for the Mac to hand back on the second stage. */
function continuationOf(blocks: Block[]): { blocks: ContinuationBlock[]; lectures: string[]; reason: string } | null {
  const out: ContinuationBlock[] = [];
  let call: { lectures: string[]; reason: string } | null = null;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
    else if (b.type === "tool_use" && b.name === FETCH_TOOL_NAME) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(b.json || "{}");
      } catch {
        return null;
      }
      const lectures = Array.isArray(input.lectures)
        ? input.lectures.filter((l): l is string => typeof l === "string").slice(0, MAX_ESCALATION_LECTURES)
        : [];
      const reason = typeof input.reason === "string" ? input.reason : "";
      call = { lectures, reason };
      out.push({ type: "tool_use", id: b.id, name: FETCH_TOOL_NAME, input: { lectures, reason } });
    }
  }
  return call ? { blocks: out, ...call } : null;
}

// --- The endpoint -----------------------------------------------------------

export const assistant = new Hono<AppEnv>();

assistant.post("/proxy/assistant", async (c) => {
  const account = c.get("account");
  const device = c.get("device");
  if (!account || !device) return c.json({ error: "not_a_device" }, 401);

  const length = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return c.json({ error: "too_large", limit_bytes: MAX_BODY_BYTES }, 413);
  }

  const gate = await db.hitRateLimit(c.env.DB, `assistant:${account.id}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!gate.allowed) {
    return c.json({ error: "rate_limited", limit: RATE_LIMIT, window_seconds: RATE_WINDOW_SECONDS }, 429, {
      "Retry-After": String(gate.retryAfter),
    });
  }

  const raw = await boundedBody(c, MAX_BODY_BYTES);
  if (isRefusal(raw)) return refuse(c, raw);
  const asked = parse(raw);
  if ("status" in asked) return refuse(c, asked);

  const estimate = estimateOf(inputChars(asked));
  if (estimate > SESSION_COST_CAP) {
    return c.json({ error: "too_large", detail: "this question would cost more than a whole session may" }, 413);
  }

  const allowed = await allowanceFor(c.env.DB, account.id);
  if ((await db.usedGlobally(c.env.DB, "assistant")) + estimate > ASSISTANT_CEILING) {
    console.log(`assistant: the ceiling for ${db.usagePeriod()} is reached; refusing until it is raised`);
    return c.json({ error: "service_ceiling", kind: "assistant", period: db.usagePeriod() }, 402);
  }

  // The session: an existing one carried by the Mac, or a new one, which is
  // the charge against the month.
  let sessionId = asked.sessionId;
  let opened = false;
  if (!sessionId) {
    const row = await openSession(c.env.DB, account.id, device.id, allowed.assistant_sessions);
    if (!row) {
      return c.json(
        {
          error: "allowance_exhausted",
          kind: "assistant",
          unit: "sessions",
          used: await db.assistantSessionsThisPeriod(c.env.DB, account.id),
          allowance: allowed.assistant_sessions,
          period: db.usagePeriod(),
        },
        402,
      );
    }
    sessionId = row.id;
    opened = true;
  }
  const escalation = asked.continuation !== null;
  const took = escalation
    ? await takeEscalation(c.env.DB, sessionId, account.id, estimate)
    : await takeQuestion(c.env.DB, sessionId, account.id, estimate);
  if (!took) {
    if (opened) await undoTake(c.env.DB, sessionId, estimate, false, true);
    if (escalation) {
      const row = await sessionById(c.env.DB, sessionId, account.id);
      if (row && row.escalations >= row.questions) {
        return c.json({ error: "already_escalated" }, 409);
      }
    }
    return refuse(c, sessionEnded(await sessionById(c.env.DB, sessionId, account.id), estimate));
  }

  // The bill, held in usage too, where the ceiling and the month are read.
  await db.sweepReservations(c.env.DB, account.id);
  const held = await db.reserveUsage(
    c.env.DB,
    account.id,
    device.id,
    "assistant",
    estimate,
    Math.max(1, allowed.assistant_sessions) * SESSION_COST_CAP,
  );
  if (!held) {
    await undoTake(c.env.DB, sessionId, estimate, escalation, opened);
    return c.json({ error: "allowance_exhausted", kind: "assistant", unit: "dollars", period: db.usagePeriod() }, 402);
  }

  const giveBack = async () => {
    await db.releaseUsage(c.env.DB, held.id);
    await undoTake(c.env.DB, sessionId, estimate, escalation, opened);
  };

  let res: Response;
  try {
    res = await fetch(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(upstreamBody(asked)),
    });
  } catch {
    await giveBack();
    return refuse(c, providerFailed("anthropic assistant", 0));
  }
  if (!res.ok || !res.body) {
    await giveBack();
    return refuse(c, providerFailed("anthropic assistant", res.status));
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const emit = async (event: Record<string, unknown>) => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      return true;
    } catch {
      return false;
    }
  };

  const session = {
    id: sessionId,
    opened,
    questions_left: SESSION_QUESTIONS - took.questions,
    sessions_left: Math.max(0, allowed.assistant_sessions - (await db.assistantSessionsThisPeriod(c.env.DB, account.id))),
  };
  const upstreamBodyStream = res.body;

  const pump = (async () => {
    await emit({ type: "session", ...session });
    const out = await relayStream(upstreamBodyStream, emit);
    // A stream that broke part way still spent tokens nobody reported, so it
    // is settled at the estimate it was held at, never at a partial count.
    const cost = out.failed ? estimate : costOf(out.usage);
    await db.settleUsage(c.env.DB, held.id, cost, "anthropic");
    await settleSession(c.env.DB, sessionId, cost - estimate);

    if (out.failed) {
      await emit({ type: "error", error: "provider_unavailable" });
    } else {
      const next = out.stopReason === "tool_use" && !escalation ? continuationOf(out.blocks) : null;
      if (next) {
        await emit({
          type: "escalate",
          session_id: sessionId,
          lectures: next.lectures,
          reason: next.reason,
          continuation: next.blocks,
        });
      }
      await emit({
        type: "done",
        session_id: sessionId,
        stop_reason: out.stopReason,
        escalating: next !== null,
        cost_microusd: cost,
        ...out.usage,
      });
    }
    await writer.close().catch(() => {});
  })();
  c.executionCtx.waitUntil(pump);

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
});
