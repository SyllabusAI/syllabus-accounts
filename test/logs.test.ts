import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrub } from "../src/log";
import { toBase64Url } from "../src/util";
import { claimDevice, get, ORIGIN, postForm, signedInAs } from "./helpers";
import { allowScrubbedLines, loggedLines } from "./no-pii-in-logs";

// test/no-pii-in-logs.ts already fails any test whose log lines name a
// person. These tests say what the lines say instead, flow by flow, and hold
// the source to the one way of writing them.

const CLIENT = "test-client-id.apps.googleusercontent.com";
const DRIVE = "https://www.googleapis.com/auth/drive.file";

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

function idToken(nonce: string, email: string) {
  return jwt({
    iss: "https://accounts.google.com", aud: CLIENT, sub: "google-sub-8841", exp: Math.floor(Date.now() / 1000) + 300,
    nonce, email, email_verified: true, name: "Priya Raman",
  });
}

function googleAnswers(answer: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => answer(String(input instanceof Request ? input.url : input))));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("what the Worker logs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names a sign-in by its account id", async () => {
    const login = await get("/login");
    const flowCookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const to = new URL(login.headers.get("Location")!);
    googleAnswers(() => json({ id_token: idToken(to.searchParams.get("nonce")!, "Priya.Raman@example.edu") }));
    const cb = await get(`/oauth2/callback?state=${to.searchParams.get("state")}&code=4/0Aauth-code-value`, { Cookie: flowCookie });
    expect(cb.status).toBe(302);
    const row = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?").bind("priya.raman@example.edu").first<{ id: string }>();
    expect(loggedLines()).toContain(`signed in: account ${row!.id}`);
    expect(loggedLines().join("\n")).not.toMatch(/Priya|google-sub-8841|4\/0Aauth/);
  });

  it("names a refused panel viewer by their account id", async () => {
    const mine = await claimDevice("owner@example.com");
    const other = await signedInAs("snooper@example.com");
    expect((await get(`/p/${mine.deviceId}/`, { Cookie: other.cookie })).status).toBe(403);
    expect(loggedLines()).toContain(
      `refused account ${other.account.id} at the panel of device ${mine.deviceId}: belongs to another account`,
    );
  });

  it("names an approved Mac and its account by id, not by the Mac's name", async () => {
    const mine = await claimDevice("approver@example.com", "Priya's MacBook Air");
    expect(loggedLines()).toContain(`device ${mine.deviceId} joined account ${mine.account.id}`);
    expect(loggedLines().join("\n")).not.toContain("Priya");
    await postForm("/devices/revoke-all", {}, { Cookie: mine.cookie });
    expect(loggedLines()).toContain(`account ${mine.account.id} signed out every Mac (1)`);
  });

  it("names a Drive connection by its account id, not by either Google address", async () => {
    const { account, cookie } = await signedInAs("drive-owner@example.com");
    const start = await get("/drive/connect", { Cookie: cookie });
    const to = new URL(start.headers.get("Location")!);
    const flowCookie = start.headers.get("Set-Cookie")!.split(";")[0];
    googleAnswers(() => json({
      access_token: "ya29.access", refresh_token: "1//refresh-value", scope: `openid email ${DRIVE}`,
      id_token: idToken(to.searchParams.get("nonce")!, "Other.Address@gmail.com"),
    }));
    const cb = await get(`/oauth2/callback?state=${to.searchParams.get("state")}&code=drive-code`, { Cookie: `${cookie}; ${flowCookie}` });
    expect(cb.status).toBe(302);
    expect(loggedLines()).toContain(`drive connected for account ${account.id}`);

    // A revoke that fails with an error quoting the request back: the line
    // is kept, and what it quoted is not.
    allowScrubbedLines();
    googleAnswers(() => {
      throw new Error("could not reach https://oauth2.googleapis.com/revoke?token=1//refresh-value for Other.Address@gmail.com");
    });
    expect((await postForm("/drive/disconnect", {}, { Cookie: cookie })).status).toBe(302);
    expect(loggedLines()).toContain(
      "could not revoke the drive grant at Google: could not reach https://oauth2.googleapis.com/revoke?[query] for [email]",
    );
  });

  it("names a Stripe checkout by account and session id, never the payer's address", async () => {
    const { account } = await signedInAs("payer@example.com");
    const raw = JSON.stringify({
      id: "evt_logs_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_logs", object: "checkout.session", mode: "subscription", customer: "cus_logs", subscription: "sub_logs",
          client_reference_id: account.id, customer_email: "payer@example.com",
          customer_details: { email: "payer@example.com", name: "Pat Payer", address: { postal_code: "02139" } },
        },
      },
    });
    const at = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${raw}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${at},v1=${hex}` },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(loggedLines().join("\n")).not.toMatch(/Pat Payer|02139/);
  });
});

describe("the log scrubber", () => {
  it("takes out addresses, query strings, and anything shaped like a key or token", () => {
    expect(scrub("for Me.Name+tag@Example.co.uk, again")).toBe("for [email], again");
    expect(scrub("GET https://oauth2.googleapis.com/token?code=4/0Aabc&x=1 failed")).toBe("GET https://oauth2.googleapis.com/token?[query] failed");
    for (const secret of ["Bearer syd_abc123", "ya29.a0AfH6", "1//0gRefresh-token", "sk_live_abc123", "rk_test_abc", "whsec_abc", "sk-ant-api03-abcdef", "sk-proj-abcdef", "gsk_abcdef"]) {
      expect(scrub(`it said ${secret} back`)).toBe("it said [secret] back");
    }
    expect(scrub("stripe: account acc_1 is now on standard")).toBe("stripe: account acc_1 is now on standard");
  });
});

// The source, read as text, so a new line is held to the rule before it runs.
const SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true });

/** Every `log(...)` call in a file, as written. */
function logCalls(text: string): string[] {
  const calls: string[] = [];
  const re = /(?<![\w.])log\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let end = m.index + 3;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      if (text[end] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(m.index, end + 1));
  }
  return calls;
}

// What a log line may never interpolate: who a person is, what proves it,
// where they are, and anything that could quote either back whole.
const FORBIDDEN = [
  /email/i, /\bname\b/, /picture/, /\.sub\b/, /claims/, /viewer/,
  /token/i, /\bcode\b/i, /secret/i, /api_?key/i,
  /connecting|forwarded|source\(c\)|\bip\b/i, /\burl\b|\.search\b|query/i, /\bbody\b(?!\.error)/, /stringify/,
];

describe("the source", () => {
  it("writes log lines only through src/log.ts", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    const offenders = Object.entries(SOURCES)
      .filter(([file]) => !file.endsWith("/log.ts"))
      .filter(([, text]) => /\bconsole\.\w+\(/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("never interpolates a person, a credential, or a whole request into a log line", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      if (file.endsWith("/log.ts")) continue;
      for (const call of logCalls(text)) {
        for (const [, expr] of call.matchAll(/\$\{([^}]*)\}/g)) {
          const hit = FORBIDDEN.find((re) => re.test(expr));
          if (hit) offenders.push(`${file}: \${${expr}} (${hit})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
