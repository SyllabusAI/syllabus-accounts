/**
 * The transcription meter cannot be talked down (threat model F-01).
 *
 * The mvhd length in an .m4a is written by the caller, so a 12MiB upload can
 * state one second. Two guards close that: a floor of bytes / 24,000 under
 * every charge, and settling to the provider's own duration when it reports a
 * larger one. Nothing leaves the test: the provider is a stub.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { AUDIO_FLOOR_BYTES_PER_SECOND, chargedSeconds, GLOBAL_CEILING, verboseJson } from "../src/proxy";
import { claimDevice, grant, ORIGIN } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";
const bearer = (token: string) => ({ Authorization: "Bearer " + token });

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** An .m4a whose header says `claimedSeconds`, padded to `bytes` with whatever follows. */
function m4aClaiming(claimedSeconds: number, bytes: number): Uint8Array {
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, 1000);
  view.setUint32(16, Math.round(claimedSeconds * 1000));
  const head = new Uint8Array([...box("ftyp", new Uint8Array(8)), ...box("moov", box("mvhd", mvhd))]);
  const out = new Uint8Array(Math.max(bytes, head.length));
  out.set(head);
  return out;
}

/** Groq answering verbose_json, with or without a duration; OpenAI answering text. */
function provider(groq: () => Response, openai: () => Response = () => new Response("from openai")) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return url === GROQ ? groq() : openai();
    }),
  );
  return calls;
}
const groqSays = (body: Record<string, unknown>) => () => new Response(JSON.stringify({ text: "the transcript", ...body }), { status: 200 });

function upload(token: string, file: Uint8Array | File, declared: number) {
  const form = new FormData();
  form.set("audio", file instanceof File ? file : new File([file], "chunk_001.m4a", { type: "audio/mp4" }));
  form.set("duration_seconds", String(declared));
  return SELF.fetch(ORIGIN + "/proxy/transcribe", { method: "POST", headers: bearer(token), body: form, redirect: "manual" });
}
const charged = async (res: Response) => ((await res.json()) as { audio_seconds: number }).audio_seconds;

const TWELVE_MIB = 12 * 1024 * 1024 - 1024;
const FLOOR_OF_TWELVE_MIB = Math.ceil(TWELVE_MIB / 24_000);

describe("the byte floor", () => {
  it("is 192kbps, and is what the proxy exports", () => {
    expect(AUDIO_FLOOR_BYTES_PER_SECOND).toBe(24_000);
  });

  it("charges a lying header on a large file by its size (the F-01 reproduction)", async () => {
    provider(groqSays({}));
    const { account, token } = await claimDevice("meter-liar@example.com");
    const res = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
    expect(res.status).toBe(200);
    expect(await charged(res)).toBe(FLOOR_OF_TWELVE_MIB);
    expect(FLOOR_OF_TWELVE_MIB).toBeGreaterThanOrEqual(500);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(FLOOR_OF_TWELVE_MIB);
  });

  // The Mac records 64kbps mono (8,000 B/s); a stream-copied import can be
  // faster. Honest files, with a few KB of container around the audio, must be
  // charged exactly their length at every rate the floor is meant to leave alone.
  for (const bytesPerSecond of [4_000, 8_000, 16_000]) {
    for (const seconds of [1, 30, 61, 480]) {
      it(`does not overcharge an honest ${(bytesPerSecond * 8) / 1000}kbps file of ${seconds}s`, async () => {
        provider(groqSays({ duration: seconds }));
        const { token } = await claimDevice(`honest-${bytesPerSecond}-${seconds}@example.com`);
        const file = m4aClaiming(seconds, bytesPerSecond * seconds + 4_096);
        const res = await upload(token, file, seconds);
        expect(res.status).toBe(200);
        expect(await charged(res)).toBe(seconds);
      });
    }
  }

  it("charges exactly the length at 192kbps, the edge of the floor", () => {
    for (const seconds of [1, 30, 480]) {
      expect(chargedSeconds(seconds, seconds, 24_000 * seconds)).toBe(seconds);
    }
  });

  it("charges size, not length, above 192kbps (a billing decision, pinned here)", () => {
    // A 320kbps stereo AAC file stream-copied from an import: 40,000 B/s.
    expect(chargedSeconds(60, 60, 40_000 * 60)).toBe(100);
  });

  it("leaves an unreadable header at 32kbps, as before", async () => {
    provider(groqSays({}));
    const { token } = await claimDevice("opaque-floor@example.com");
    // Not an MP4, claiming one second: 400kB at 4,000 B/s, not at the floor's 24,000.
    expect(await charged(await upload(token, new Uint8Array(400_000), 1))).toBe(100);
    expect(chargedSeconds(null, 1, 400_000)).toBe(100);
    // A declared length larger than the byte count still wins there too.
    expect(chargedSeconds(null, 200, 400_000)).toBe(200);
  });

  it("still lets a declared duration raise the charge over the header and the floor", async () => {
    provider(groqSays({}));
    const { token } = await claimDevice("declared-wins@example.com");
    expect(await charged(await upload(token, m4aClaiming(60, 10_000), 300))).toBe(300);
    expect(chargedSeconds(60, 300, 10_000)).toBe(300);
  });

  it("still lets an honest header beat a smaller declaration", () => {
    expect(chargedSeconds(480, 1, 64_000)).toBe(480);
  });

  it("stops the per-account allowance with lying headers", async () => {
    provider(groqSays({}));
    const { account, token } = await claimDevice("allowance-liar@example.com");
    await db.putAllowance(env.DB, account.id, grant(600, 1_000_000));
    // Before the floor each of these was one second and all four would pass.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await upload(token, m4aClaiming(1, TWELVE_MIB), 1)).status);
    expect(statuses).toEqual([200, 402, 402, 402]);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(FLOOR_OF_TWELVE_MIB);
  });

  it("stops the global ceiling with lying headers", async () => {
    const calls = provider(groqSays({}));
    const other = await claimDevice("ceiling-other@example.com");
    const { token } = await claimDevice("ceiling-liar@example.com");
    // Room for exactly one floored upload across every account.
    // Storage is shared by the tests in this file, so measure what is already spent.
    const spent = await db.usedGlobally(env.DB, "transcribe");
    await db.recordUsage(env.DB, other.account.id, other.deviceId, "transcribe", GLOBAL_CEILING.audio_seconds - spent - FLOOR_OF_TWELVE_MIB - 10);
    let first: Response;
    let second: Response;
    try {
      first = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
      second = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
    } finally {
      // The filler must not starve the tests that follow.
      await env.DB.prepare("DELETE FROM usage WHERE account_id = ? AND kind = 'transcribe'").bind(other.account.id).run();
    }
    expect([first.status, second.status]).toEqual([200, 402]);
    expect(((await second.json()) as { error: string }).error).toBe("service_ceiling");
    expect(calls).toHaveLength(1);
  });
});

describe("settling to the provider's duration", () => {
  it("bills the provider's duration when it is longer than the floor", async () => {
    provider(groqSays({ duration: 16_000.4 }));
    const { account, token } = await claimDevice("settle-up@example.com");
    const res = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
    expect(await charged(res)).toBe(16_001);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(16_001);
    const row = await env.DB.prepare("SELECT units, state, provider FROM usage WHERE account_id = ?").bind(account.id).first();
    expect(row).toEqual({ units: 16_001, state: "final", provider: "groq" });
  });

  it("bills the same when the provider agrees with the floor", async () => {
    provider(groqSays({ duration: FLOOR_OF_TWELVE_MIB }));
    const { token } = await claimDevice("settle-equal@example.com");
    expect(await charged(await upload(token, m4aClaiming(1, TWELVE_MIB), 1))).toBe(FLOOR_OF_TWELVE_MIB);
  });

  it("never bills below the floor when the provider reports less", async () => {
    provider(groqSays({ duration: 3 }));
    const { account, token } = await claimDevice("settle-down@example.com");
    expect(await charged(await upload(token, m4aClaiming(1, TWELVE_MIB), 1))).toBe(FLOOR_OF_TWELVE_MIB);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(FLOOR_OF_TWELVE_MIB);
  });

  for (const [name, body] of [
    ["missing", {}],
    ["zero", { duration: 0 }],
    ["negative", { duration: -5 }],
    ["not a number", { duration: "long" }],
    ["null", { duration: null }],
  ] as const) {
    it(`falls back to the floor when the duration is ${name}`, async () => {
      provider(groqSays(body));
      const { account, token } = await claimDevice(`settle-${name.replace(/ /g, "-")}@example.com`);
      const res = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
      expect(res.status).toBe(200);
      expect(await charged(res)).toBe(FLOOR_OF_TWELVE_MIB);
      expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(FLOOR_OF_TWELVE_MIB);
    });
  }

  it("keeps the OpenAI leg at the floor, since it reports no duration", async () => {
    provider(() => new Response("rate limited", { status: 429 }));
    const { token } = await claimDevice("settle-openai@example.com");
    expect(await charged(await upload(token, m4aClaiming(1, TWELVE_MIB), 1))).toBe(FLOOR_OF_TWELVE_MIB);
  });

  it("treats a 200 from Groq that is not verbose_json as a failed leg, not a transcript", async () => {
    const calls = provider(() => new Response("plain words, not json", { status: 200 }), () => new Response("from openai"));
    const { token } = await claimDevice("settle-notjson@example.com");
    const res = await upload(token, m4aClaiming(60, 10_000), 60);
    expect(((await res.json()) as { text: string }).text).toBe("from openai");
    expect(calls).toEqual([GROQ, "https://api.openai.com/v1/audio/transcriptions"]);
  });

  it("lets settling go past the allowance once, and the next request is refused", async () => {
    provider(groqSays({ duration: 10_000 }));
    const { account, token } = await claimDevice("settle-over@example.com");
    await db.putAllowance(env.DB, account.id, grant(600, 1_000_000));
    const first = await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
    expect(first.status).toBe(200);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(10_000);
    expect((await upload(token, m4aClaiming(1, 1_000), 1)).status).toBe(402);
  });

  it("counts a reservation at the floor while the call is in flight", async () => {
    let seenInFlight = -1;
    const { account, token } = await claimDevice("settle-inflight@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        seenInFlight = await db.usedThisPeriod(env.DB, account.id, "transcribe");
        return new Response(JSON.stringify({ text: "t", duration: 9_000 }), { status: 200 });
      }),
    );
    await upload(token, m4aClaiming(1, TWELVE_MIB), 1);
    expect(seenInFlight).toBe(FLOOR_OF_TWELVE_MIB);
    expect(await db.usedThisPeriod(env.DB, account.id, "transcribe")).toBe(9_000);
  });
});

describe("verboseJson", () => {
  it("reads text and duration", () => {
    expect(verboseJson('{"text":"hi","duration":12.5}')).toEqual({ text: "hi", duration: 12.5, segments: null });
    expect(verboseJson('{"text":"hi","duration":"7"}')).toEqual({ text: "hi", duration: 7, segments: null });
  });
  it("gives no duration for anything that is not a positive number", () => {
    for (const d of ["0", "-1", "null", '"x"', "[]"]) expect(verboseJson(`{"text":"hi","duration":${d}}`)?.duration).toBeNull();
    expect(verboseJson('{"text":"hi"}')?.duration).toBeNull();
  });
  it("rejects a body with no text or no JSON", () => {
    expect(verboseJson("words")).toBeNull();
    expect(verboseJson('{"duration":3}')).toBeNull();
    expect(verboseJson("null")).toBeNull();
  });
});
