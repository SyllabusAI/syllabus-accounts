import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, keyId, sealedKeyId } from "../src/crypto";
import { openGrant, sweepDriveGrants, unseal } from "../src/drive-keys";
import { pagePolicy } from "../src/headers";
import { scheduled } from "../src/index";
import { LIMITS, type Limit } from "../src/limits";
import { safeNext } from "../src/google";
import { sessionSecret } from "../src/session";
import { toBase64Url } from "../src/util";
import { claimDevice, get, ORIGIN, postForm, postJson, signedInAs } from "./helpers";

const CLIENT = "test-client-id.apps.googleusercontent.com";

/**
 * Fill a rate-limit bucket to its limit, in this window and the next.
 *
 * Both windows, so a test that happens to run across a window boundary still
 * finds the bucket full; the fixed-window flake the proxy test has comes
 * from exactly that.
 */
async function fill(bucket: string, rule: Limit) {
  const start = Math.floor(Date.now() / 1000 / rule.window) * rule.window;
  for (const w of [start, start + rule.window]) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?) ON CONFLICT (bucket, window_start) DO UPDATE SET count = excluded.count",
    )
      .bind(bucket, w, rule.limit)
      .run();
  }
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

async function s256(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

describe("where a sign-in may send the browser afterwards", () => {
  it("keeps paths on this site, query and all", () => {
    expect(safeNext("/device?code=ABCD-EFGH")).toBe("/device?code=ABCD-EFGH");
    expect(safeNext("/p/abc/setup?x=1#top")).toBe("/p/abc/setup?x=1#top");
  });
  it("refuses every spelling a browser reads as another host", () => {
    for (const bad of ["//evil.test", "/\\evil.test", "/\\/evil.test", "/\t/evil.test", "/\n/evil.test", "https://evil.test", "evil.test", ""]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe("/");
    }
  });
  it("is what /login stores, whatever it was given", async () => {
    const res = await get("/login?next=" + encodeURIComponent("/\\evil.test"));
    expect(res.status).toBe(302);
    // The flow cookie is signed, not encrypted: the stored next is readable.
    const cookie = decodeURIComponent(res.headers.get("Set-Cookie")!.split(";")[0]);
    expect(cookie).toContain('"next":"/"');
  });
});

describe("PKCE on both Google flows", () => {
  afterEach(() => vi.unstubAllGlobals());

  function googleAnswers(body: (sent: URLSearchParams) => unknown) {
    const calls: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = new URLSearchParams(String(init?.body ?? ""));
        calls.push(sent);
        return new Response(JSON.stringify(body(sent)), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    return calls;
  }

  it("sends an S256 challenge and redeems the code with its verifier", async () => {
    const login = await get("/login");
    const to = new URL(login.headers.get("Location")!);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = to.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const nonce = to.searchParams.get("nonce")!;
    const calls = googleAnswers(() => ({
      id_token: jwt({ iss: "https://accounts.google.com", aud: CLIENT, sub: "pkce-1", exp: Date.now() / 1000 + 300, nonce, email: "pkce@example.com", email_verified: true }),
    }));
    const cb = await get(`/oauth2/callback?state=${to.searchParams.get("state")}&code=c`, {
      Cookie: login.headers.get("Set-Cookie")!.split(";")[0],
    });
    expect(cb.status).toBe(302);
    const verifier = calls[0].get("code_verifier")!;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(await s256(verifier)).toBe(challenge);
  });

  it("does the same for the Drive consent", async () => {
    const { cookie } = await signedInAs("pkce-drive@example.com");
    const start = await get("/drive/connect", { Cookie: cookie });
    const to = new URL(start.headers.get("Location")!);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    const nonce = to.searchParams.get("nonce")!;
    const calls = googleAnswers(() => ({
      refresh_token: "1//r",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      id_token: jwt({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g", exp: Date.now() / 1000 + 300, nonce, email: "g@example.com", email_verified: true }),
    }));
    const cb = await get(`/oauth2/callback?state=${to.searchParams.get("state")}&code=c`, {
      Cookie: `${cookie}; ${start.headers.get("Set-Cookie")!.split(";")[0]}`,
    });
    expect(cb.status).toBe(302);
    expect(await s256(calls[0].get("code_verifier")!)).toBe(to.searchParams.get("code_challenge"));
  });

  it("refuses a sign-in flow that carries no verifier", async () => {
    const flow = { state: "s1", nonce: "n1", next: "/", t: Date.now() };
    const cookie = (await serializeSigned("__Host-syllabus_accounts_signin", JSON.stringify(flow), env.SESSION_SECRET, { path: "/", secure: true })).split(";")[0];
    const calls = googleAnswers(() => ({}));
    const cb = await get("/oauth2/callback?state=s1&code=c", { Cookie: cookie });
    expect(cb.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("does not sign out on a GET from another site; it asks", async () => {
    const { cookie } = await signedInAs("so@example.com");
    for (const site of [undefined, "cross-site", "same-site"]) {
      const res = await get("/logout", { Cookie: cookie, ...(site ? { "Sec-Fetch-Site": site } : {}) });
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie") ?? "").not.toContain("__Host-syllabus_accounts_session=;");
      expect(await res.text()).toContain('action="/logout"');
    }
  });
  it("signs out on a GET from this site (the relayed panel's link) or typed by hand", async () => {
    const { cookie } = await signedInAs("so@example.com");
    for (const site of ["same-origin", "none"]) {
      const res = await get("/logout", { Cookie: cookie, "Sec-Fetch-Site": site });
      expect(res.headers.get("Set-Cookie")).toContain("__Host-syllabus_accounts_session=;");
    }
  });
  it("needs a same-origin form post", async () => {
    const { cookie } = await signedInAs("so@example.com");
    const bad = await postForm("/logout", {}, { Cookie: cookie, Origin: "https://evil.test" });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("Set-Cookie") ?? "").not.toContain("__Host-syllabus_accounts_session=;");
    const good = await postForm("/logout", {}, { Cookie: cookie });
    expect(good.headers.get("Set-Cookie")).toContain("__Host-syllabus_accounts_session=;");
  });
});

describe("rate limits on the routes that answer strangers", () => {
  it("sizes per-address limits for a lecture hall behind one NAT address", () => {
    expect(LIMITS.login.limit).toBeGreaterThanOrEqual(600);
    expect(LIMITS.callback.limit).toBeGreaterThanOrEqual(600);
    expect(LIMITS.deviceApproveAddress.limit).toBeGreaterThanOrEqual(10 * LIMITS.deviceApprove.limit);
  });

  it("limits /login per address", async () => {
    const ip = "198.51.100.10";
    await fill(`login:${ip}`, LIMITS.login);
    const res = await get("/login", { "CF-Connecting-IP": ip });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.text()).toContain("Too many tries");
    expect((await get("/login", { "CF-Connecting-IP": "198.51.100.11" })).status).toBe(302);
  });

  it("limits /oauth2/callback per address, before calling Google", async () => {
    const ip = "198.51.100.20";
    await fill(`callback:${ip}`, LIMITS.callback);
    expect((await get("/oauth2/callback?state=x&code=y", { "CF-Connecting-IP": ip })).status).toBe(429);
  });

  it("limits looking up a device code, per account", async () => {
    const { account, cookie } = await signedInAs("lookup@example.com");
    expect((await get("/device?code=ABCD-EFGH", { Cookie: cookie })).status).toBe(200);
    await fill(`device-lookup:${account.id}`, LIMITS.deviceLookup);
    expect((await get("/device?code=ABCD-EFGH", { Cookie: cookie })).status).toBe(429);
    // The empty form is not a lookup.
    expect((await get("/device", { Cookie: cookie })).status).toBe(200);
  });

  it("limits approving codes, per account and per address", async () => {
    const started = (await (await postJson("/device/start", { name: "Guessed Mac" })).json()) as { user_code: string };
    const guesser = await signedInAs("guesser@example.com");
    await fill(`device-approve:${guesser.account.id}`, LIMITS.deviceApprove);
    const refused = await postForm("/device/approve", { user_code: started.user_code }, { Cookie: guesser.cookie });
    expect(refused.status).toBe(429);

    const ip = "198.51.100.30";
    const other = await signedInAs("guesser2@example.com");
    await fill(`device-approve-ip:${ip}`, LIMITS.deviceApproveAddress);
    const alsoRefused = await postForm("/device/approve", { user_code: started.user_code }, { Cookie: other.cookie, "CF-Connecting-IP": ip });
    expect(alsoRefused.status).toBe(429);

    // Nobody got the Mac, and its owner still can.
    const owner = await signedInAs("owner@example.com");
    expect((await postForm("/device/approve", { user_code: started.user_code }, { Cookie: owner.cookie })).status).toBe(200);
  });

  it("limits the Stripe webhook per address, before reading or verifying anything", async () => {
    const ip = "198.51.100.40";
    await fill(`stripe-webhook:${ip}`, LIMITS.stripeWebhook);
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00", "CF-Connecting-IP": ip },
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("limits the billing routes per account", async () => {
    const { account, cookie } = await signedInAs("billing-limit@example.com");
    await fill(`billing:${account.id}`, LIMITS.billing);
    expect((await postForm("/billing/portal", {}, { Cookie: cookie })).status).toBe(429);
  });

  it("still never answers /device/poll with a 429", async () => {
    const ip = "198.51.100.50";
    await fill(`device-poll:${ip}`, LIMITS.devicePoll);
    const res = await postJson("/device/poll", { device_code: "x" }, { "CF-Connecting-IP": ip });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("slow_down");
  });
});

describe("security headers", () => {
  it("puts a strict policy on the pages this Worker writes", async () => {
    const res = await get("/");
    const policy = await pagePolicy();
    expect(res.headers.get("Content-Security-Policy")).toBe(policy);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("puts the safe headers, and no page policy, on JSON and on a relayed panel", async () => {
    const health = await get("/healthz");
    expect(health.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(health.headers.get("Content-Security-Policy")).toBeNull();

    // A JSON answer is not cached either (F-20): this one carries a device code.
    const started = await postJson("/device/start", {});
    expect(started.headers.get("Content-Type")).toContain("application/json");
    expect(started.headers.get("Cache-Control")).toBe("no-store");

    // The not-connected page comes back from the Durable Object, whose
    // response headers are immutable; they are added to a copy.
    const mine = await claimDevice("headers@example.com");
    const panel = await get(`/p/${mine.deviceId}/`, { Cookie: mine.cookie });
    expect(panel.status).toBe(503);
    expect(panel.headers.get("X-Frame-Options")).toBe("DENY");
    expect(panel.headers.get("Content-Security-Policy")).toBeNull();
    expect(panel.headers.get("Retry-After")).toBe("10");
  });

  it("covers the webhook, which runs before the auth middleware", async () => {
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", { method: "POST", body: "{}" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("request size", () => {
  it("refuses an oversized body on an open route, stated or streamed", async () => {
    const big = "x".repeat(600 * 1024);
    const stated = await postJson("/device/start", { name: big });
    expect(stated.status).toBe(413);

    const bytes = new TextEncoder().encode(JSON.stringify({ name: big }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 64 * 1024) controller.enqueue(bytes.subarray(at, at + 64 * 1024));
        controller.close();
      },
    });
    const streamed = await SELF.fetch(ORIGIN + "/device/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.60" },
      body: stream,
      // @ts-expect-error: workerd's RequestInit takes duplex for a streamed body
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  it("still takes the largest real body, a settings document", async () => {
    const mine = await claimDevice("settings-size@example.com");
    const res = await SELF.fetch(ORIGIN + "/settings/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + mine.token },
      body: JSON.stringify({ content: "é".repeat(60 * 1024) }).replace(/é/g, "\\u00e9"),
    });
    expect(res.status).toBe(200);
  });
});

describe("the session secret", () => {
  it("is refused when unset rather than signing with an empty key", () => {
    const fake = { env: { SESSION_SECRET: "" } } as unknown as Parameters<typeof sessionSecret>[0];
    expect(() => sessionSecret(fake)).toThrow(/SESSION_SECRET/);
  });
});

describe("rotating DRIVE_KEY", () => {
  const keys = { DRIVE_KEY: "new-key", DRIVE_KEY_PREVIOUS: "old-key" };

  /** A value sealed the way the code before key ids did: `<iv>.<box>`. */
  async function legacySeal(secret: string, text: string) {
    const sealed = await encrypt(secret, text);
    return sealed.split(".").slice(0, 2).join(".");
  }

  it("names the key in every sealed value, last, so older code still opens it", async () => {
    const sealed = await encrypt("new-key", "1//tok");
    expect(sealedKeyId(sealed)).toBe(await keyId("new-key"));
    expect(sealedKeyId(sealed)).toMatch(/^[0-9a-f]{8}$/);
    // What decrypt() did before this change: the first two parts.
    const [iv, box] = sealed.split(".");
    expect(await decrypt("new-key", `${iv}.${box}`)).toBe("1//tok");
  });

  it("opens current, previous, and pre-key-id values, and says which need resealing", async () => {
    expect(await unseal(keys, await encrypt("new-key", "a"))).toEqual({ plain: "a", stale: false });
    expect(await unseal(keys, await encrypt("old-key", "b"))).toEqual({ plain: "b", stale: true });
    expect(await unseal(keys, await legacySeal("new-key", "c"))).toEqual({ plain: "c", stale: true });
    expect(await unseal(keys, await legacySeal("old-key", "d"))).toEqual({ plain: "d", stale: true });
    await expect(unseal(keys, await encrypt("some-other-key", "e"))).rejects.toThrow();
    await expect(unseal({ DRIVE_KEY: "new-key" }, await encrypt("old-key", "f"))).rejects.toThrow();
  });

  async function grantRow(sealed: string) {
    const { account } = await signedInAs(`rot-${Math.random().toString(36).slice(2)}@example.com`);
    await env.DB.prepare(
      "INSERT INTO drive_grants (account_id, refresh_token_enc, scopes, google_email, granted_at) VALUES (?, ?, 'drive.file', '', '2026-01-01')",
    )
      .bind(account.id, sealed)
      .run();
    return account.id;
  }

  async function sealedOf(accountId: string) {
    return (await env.DB.prepare("SELECT refresh_token_enc FROM drive_grants WHERE account_id = ?").bind(accountId).first<{ refresh_token_enc: string }>())!
      .refresh_token_enc;
  }

  it("reseals a grant under the current key the first time it is opened", async () => {
    const id = await grantRow(await encrypt("old-key", "1//old"));
    const e = { DB: env.DB, ...keys };
    expect(await openGrant(e, { account_id: id, refresh_token_enc: await sealedOf(id) })).toBe("1//old");
    const now = await sealedOf(id);
    expect(sealedKeyId(now)).toBe(await keyId("new-key"));
    expect(await decrypt("new-key", now)).toBe("1//old");
  });

  it("never overwrites a grant that changed after it was read", async () => {
    const stale = await encrypt("old-key", "1//old");
    const id = await grantRow(stale);
    const replaced = await encrypt("new-key", "1//replaced");
    await env.DB.prepare("UPDATE drive_grants SET refresh_token_enc = ? WHERE account_id = ?").bind(replaced, id).run();
    await openGrant({ DB: env.DB, ...keys }, { account_id: id, refresh_token_enc: stale });
    expect(await sealedOf(id)).toBe(replaced);
  });

  it("sweeps every grant onto the current key and reports what it could not open", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    const a = await grantRow(await encrypt("old-key", "a"));
    const b = await grantRow(await legacySeal("new-key", "b"));
    const c = await grantRow(await encrypt("new-key", "c"));
    const lost = await grantRow(await encrypt("long-gone-key", "x"));
    const e = { DB: env.DB, ...keys };
    const first = await sweepDriveGrants(e);
    expect(first).toEqual({ resealed: 2, unreadable: 1, remaining: 1 });
    for (const [id, plain] of [[a, "a"], [b, "b"], [c, "c"]] as const) {
      const sealed = await sealedOf(id);
      expect(sealedKeyId(sealed)).toBe(await keyId("new-key"));
      expect(await decrypt("new-key", sealed)).toBe(plain);
    }
    expect(sealedKeyId(await sealedOf(lost))).toBe(await keyId("long-gone-key"));
    // Idempotent: a second run has nothing to do.
    expect(await sweepDriveGrants(e)).toEqual({ resealed: 0, unreadable: 1, remaining: 1 });
  });

  it("serves a Drive token from a grant sealed under the previous key, end to end", async () => {
    const mine = await claimDevice("rot-e2e@example.com");
    await env.DB.prepare(
      "INSERT INTO drive_grants (account_id, refresh_token_enc, scopes, google_email, granted_at) VALUES (?, ?, 'drive.file', 'g@example.com', '2026-01-01')",
    )
      .bind(mine.account.id, await encrypt(env.DRIVE_KEY_PREVIOUS, "1//from-before"))
      .run();
    const sent: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new URLSearchParams(String(init?.body ?? "")));
        return Response.json({ access_token: "ya29.x", expires_in: 3600 });
      }),
    );
    try {
      const res = await postJson("/drive/token", {}, { Authorization: "Bearer " + mine.token });
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent[0].get("refresh_token")).toBe("1//from-before");
    expect(sealedKeyId(await sealedOf(mine.account.id))).toBe(await keyId(env.DRIVE_KEY));
  });

  it("runs the sweep from the hourly scheduled handler", async () => {
    await env.DB.prepare("DELETE FROM drive_grants").run();
    const id = await grantRow(await encrypt(env.DRIVE_KEY_PREVIOUS, "1//cron"));
    const ctx = createExecutionContext();
    await scheduled({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(sealedKeyId(await sealedOf(id))).toBe(await keyId(env.DRIVE_KEY));
  });
});
