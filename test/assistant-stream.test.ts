import { describe, expect, it } from "vitest";
import { relayStream, STREAM_DEADLINE_SECONDS, STREAM_IDLE_SECONDS } from "../src/assistant";
import { RESERVATION_SECONDS } from "../src/db";

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const START = frame({ type: "message_start", message: { usage: { input_tokens: 900, output_tokens: 1 } } });
const silent = async () => true;

/** A provider stream that sends `first`, then whatever `then` does, and never closes on its own. */
function stalling(first: Uint8Array[], then: (push: (chunk: Uint8Array) => void) => void = () => {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of first) controller.enqueue(chunk);
      then((chunk) => {
        if (!cancelled) controller.enqueue(chunk);
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

describe("an assistant stream that stalls (F-16)", () => {
  it("ends before its reservation could be swept, so it is always billed", () => {
    expect(STREAM_DEADLINE_SECONDS).toBeLessThan(RESERVATION_SECONDS);
    expect(STREAM_IDLE_SECONDS).toBeLessThan(STREAM_DEADLINE_SECONDS);
  });

  it("gives up on a stream that goes quiet, as a failure, and stops reading it", async () => {
    const upstream = stalling([START]);
    const started = Date.now();
    const out = await relayStream(upstream.stream, silent, { idleMs: 50, deadlineMs: 10_000 });
    expect(out.failed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(upstream.wasCancelled()).toBe(true);
  });

  it("gives up on a stream that keeps pinging past its deadline", async () => {
    const ping = frame({ type: "ping" });
    const upstream = stalling([START], (push) => {
      const beat = setInterval(() => push(ping), 10);
      setTimeout(() => clearInterval(beat), 3_000);
    });
    const out = await relayStream(upstream.stream, silent, { idleMs: 1_000, deadlineMs: 150 });
    expect(out.failed).toBe(true);
    expect(upstream.wasCancelled()).toBe(true);
  });

  it("leaves a stream that finishes in time alone", async () => {
    const done = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(START);
        controller.enqueue(frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }));
        controller.close();
      },
    });
    const out = await relayStream(done, silent, { idleMs: 1_000, deadlineMs: 5_000 });
    expect(out.failed).toBe(false);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage.output_tokens).toBe(40);
  });
});
