import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Bindings } from "../src/env";
import { FORM_ACTION_HOSTS, pagePolicy, securityHeaders } from "../src/headers";
import { STYLE } from "../src/pages";
import { claimDevice, get, postForm, signedInAs } from "./helpers";

/** sha256 of the sheet, computed here by hand so the test does not lean on the code it checks. */
async function styleHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE));
  return "sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Everything a page could run or load on its own, which the policy leaves nothing to admit. */
function assertInert(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/<(link|img|iframe|frame|object|embed|base|meta http-equiv)\b/i);
  // One <style>, and it is the sheet the policy hashes.
  const sheets = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  expect(sheets).toEqual([STYLE]);
  expect(html.match(/<style/g)?.length).toBe(1);
}

describe("the policy on pages this Worker writes", () => {
  it("is strict: nothing runs, nothing loads, forms go home or to Stripe", async () => {
    const csp = await pagePolicy();
    const directives = new Map(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).toEqual(["'none'"]);
    expect(directives.get("style-src")).toEqual([`'${await styleHash()}'`]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'self'", ...FORM_ACTION_HOSTS]);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/\*/);
    // No other directive admits an origin: the only hosts anywhere are the two form targets.
    expect(csp.match(/https?:\/\/[^\s;]+/g)).toEqual(FORM_ACTION_HOSTS);
  });

  it("hashes exactly the stylesheet the pages carry", async () => {
    const res = await get("/privacy");
    expect(res.headers.get("Content-Security-Policy")).toContain(`style-src '${await styleHash()}'`);
    assertInert(await res.text());
  });

  // One request for each kind of page the Worker answers with HTML.
  const classes: [string, () => Promise<Response>][] = [
    ["landing", () => get("/")],
    ["privacy", () => get("/privacy")],
    ["terms", () => get("/terms")],
    [
      "account page, with a Mac and the billing forms",
      async () => {
        const mine = await claimDevice("csp-account@example.com", "CSP Mac");
        return get("/", { Cookie: mine.cookie });
      },
    ],
    [
      "device code form",
      async () => get("/device", { Cookie: (await signedInAs("csp-device@example.com")).cookie }),
    ],
    [
      "device approval error",
      async () =>
        postForm("/device/approve", { user_code: "nope" }, { Cookie: (await signedInAs("csp-approve@example.com")).cookie }),
    ],
    [
      "delete account",
      async () => get("/account/delete", { Cookie: (await signedInAs("csp-delete@example.com")).cookie }),
    ],
    [
      "billing refusal",
      async () =>
        postForm("/billing/checkout", { tier: "not-a-plan" }, { Cookie: (await signedInAs("csp-billing@example.com")).cookie }),
    ],
    ["sign-in failure", () => get("/oauth2/callback?code=x&state=y")],
  ];
  for (const [name, request] of classes) {
    it(`covers the ${name} page`, async () => {
      const res = await request();
      expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(res.headers.get("Content-Security-Policy")).toBe(await pagePolicy());
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      assertInert(await res.text());
    });
  }

  it("is identical on every response, because it names a constant sheet and needs no nonce", async () => {
    const a = (await get("/privacy")).headers.get("Content-Security-Policy");
    const b = (await get("/terms")).headers.get("Content-Security-Policy");
    expect(a).toBe(b);
    expect(a).not.toMatch(/nonce-/);
  });

  it("stays off JSON, plain text, and redirects", async () => {
    for (const res of [await get("/healthz"), await get("/me"), await get("/no-such-page"), await get("/login")]) {
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    }
  });
});

describe("the middleware never overwrites a policy a handler chose", () => {
  const app = new Hono<AppEnv>();
  app.use("*", securityHeaders);
  app.get("/own", (c) => c.html("<p>x</p>", 200, { "Content-Security-Policy": "default-src 'self'" }));
  app.get("/plain", (c) => c.html("<p>x</p>"));
  const bindings = { ...(env as unknown as Bindings) };

  it("keeps a handler's policy and still fills in the others", async () => {
    const res = await app.request("/own", {}, bindings);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("gives a page with none the page policy", async () => {
    const res = await app.request("/plain", {}, bindings);
    expect(res.headers.get("Content-Security-Policy")).toBe(await pagePolicy());
  });
});
