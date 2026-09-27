import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TOKEN_IDLE_DAYS, TOKEN_TOUCH_SECONDS, tokenStanding } from "../src/devices";
import { sha256Hex } from "../src/util";
import { claimDevice, get, ORIGIN, postJson } from "./helpers";

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const bearer = (token: string) => ({ Authorization: "Bearer " + token });

async function lastUsed(token: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT last_used_at FROM device_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ last_used_at: string | null }>();
  return row!.last_used_at;
}

async function setLastUsed(token: string, value: string | null, createdAt?: string) {
  await env.DB.prepare("UPDATE device_tokens SET last_used_at = ?, created_at = COALESCE(?, created_at) WHERE token_hash = ?")
    .bind(value, createdAt ?? null, await sha256Hex(token))
    .run();
}

/**
 * One request of every kind a device bearer is accepted on. None of these
 * reach Google or a model: a live token gets a refusal of its own (no grant,
 * no upgrade, a bad body), which is enough to tell it from a 401.
 */
const bearerRoutes: Array<[string, (token: string) => Promise<Response>]> = [
  ["GET /me", (t) => get("/me", bearer(t))],
  ["GET /settings/schedule", (t) => get("/settings/schedule", bearer(t))],
  [
    "PUT /settings/schedule",
    (t) =>
      SELF.fetch(ORIGIN + "/settings/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...bearer(t) },
        body: JSON.stringify({ content: 5 }),
      }),
  ],
  ["POST /drive/token", (t) => postJson("/drive/token", {}, bearer(t))],
  ["GET /proxy/usage", (t) => get("/proxy/usage", bearer(t))],
  ["POST /proxy/summarize", (t) => postJson("/proxy/summarize", {}, bearer(t))],
  ["GET /relay/connect", (t) => get("/relay/connect", { Upgrade: "websocket", ...bearer(t) })],
  ["POST /device/revoke", (t) => postJson("/device/revoke", {}, bearer(t))],
];

describe("how long a token lives unused", () => {
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("is live inside a day, stamped after a day, and expired after the idle window", () => {
    expect(tokenStanding(at(0), now)).toBe("live");
    expect(tokenStanding(at(TOKEN_TOUCH_SECONDS * 1000 - 1), now)).toBe("live");
    expect(tokenStanding(at(TOKEN_TOUCH_SECONDS * 1000), now)).toBe("touch");
    expect(tokenStanding(at(TOKEN_IDLE_DAYS * DAY), now)).toBe("touch");
    expect(tokenStanding(at(TOKEN_IDLE_DAYS * DAY + 1), now)).toBe("expired");
  });

  it("counts a token that was never stamped as used just now", () => {
    expect(tokenStanding(null, now)).toBe("touch");
    expect(tokenStanding("not a date", now)).toBe("touch");
  });
});

describe("device token expiry", () => {
  it("is stamped when minted and works at once", async () => {
    const mine = await claimDevice("fresh@example.com");
    const stamp = await lastUsed(mine.token);
    expect(stamp).not.toBeNull();
    expect(Date.now() - Date.parse(stamp!)).toBeLessThan(60_000);
    expect((await get("/me", bearer(mine.token))).status).toBe(200);
    // Used within the day it was stamped: no second write.
    expect(await lastUsed(mine.token)).toBe(stamp);
  });

  it("works on every bearer route while fresh", async () => {
    const mine = await claimDevice("everywhere@example.com");
    for (const [name, call] of bearerRoutes) {
      const res = await call(mine.token);
      expect(res.status, name).not.toBe(401);
    }
  });

  it("writes the stamp at most once a day", async () => {
    const mine = await claimDevice("throttle@example.com");
    const recent = daysAgo(0.5);
    await setLastUsed(mine.token, recent);
    for (let i = 0; i < 3; i++) expect((await get("/me", bearer(mine.token))).status).toBe(200);
    expect(await lastUsed(mine.token)).toBe(recent);
  });

  it("slides forward when a token is used after a quiet stretch", async () => {
    const mine = await claimDevice("slide@example.com");
    await setLastUsed(mine.token, daysAgo(TOKEN_IDLE_DAYS - 1));
    expect((await get("/me", bearer(mine.token))).status).toBe(200);
    const slid = await lastUsed(mine.token);
    expect(Date.now() - Date.parse(slid!)).toBeLessThan(60_000);
    // And it keeps working for another full window from here.
    expect((await get("/me", bearer(mine.token))).status).toBe(200);
  });

  it("refuses a token unused past the window on every bearer route, saying why", async () => {
    const mine = await claimDevice("abandoned@example.com");
    const stale = daysAgo(TOKEN_IDLE_DAYS + 1);
    await setLastUsed(mine.token, stale);
    for (const [name, call] of bearerRoutes) {
      const res = await call(mine.token);
      expect(res.status, name).toBe(401);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.error, name).toBe("invalid_token");
      expect(body.reason, name).toBe("token_expired");
    }
    // Being refused is not a use: the window does not slide back open.
    expect(await lastUsed(mine.token)).toBe(stale);
    // /device/revoke was refused above, so the token was not revoked; it is
    // the expiry alone that keeps it out.
    const row = await env.DB.prepare("SELECT revoked_at FROM device_tokens WHERE token_hash = ?")
      .bind(await sha256Hex(mine.token))
      .first<{ revoked_at: string | null }>();
    expect(row!.revoked_at).toBeNull();
  });

  it("keeps a token from before stamping working, however old, and stamps it", async () => {
    const mine = await claimDevice("legacy@example.com");
    await setLastUsed(mine.token, null, daysAgo(400));
    for (const [name, call] of bearerRoutes.filter(([n]) => n !== "POST /device/revoke")) {
      expect((await call(mine.token)).status, name).not.toBe(401);
    }
    const stamped = await lastUsed(mine.token);
    expect(stamped).not.toBeNull();
    expect(Date.now() - Date.parse(stamped!)).toBeLessThan(60_000);
  });

  it("does not change the answer for a revoked or unknown token", async () => {
    const res = await get("/me", bearer("syd_nope"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
});
