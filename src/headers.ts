/**
 * What every response carries, and how big a request may be.
 *
 * Headers. Every response gets nosniff, a Referrer-Policy, a refusal to be
 * framed, and (on https) HSTS. The pages this Worker writes itself also get a
 * Content-Security-Policy (pagePolicy below): they have no script at all and
 * one inline stylesheet, so the policy says exactly that. A relayed panel page
 * (/p/<device>/...) is the panel's own HTML with its own inline scripts, so
 * it gets the headers that cannot break it and not this policy.
 *
 * Referrer-Policy is same-origin rather than no-referrer because sameOrigin()
 * falls back to the Referer on a form post that carries no Origin; a
 * same-origin referrer is all it needs, and a /device?code= address never
 * travels to another site.
 *
 * Body size. Every route but the proxy (which has its own, larger, counted
 * caps in proxy.ts) refuses a body over BODY_LIMIT before a handler reads it,
 * whether or not the request states a length. The largest real body here is
 * a settings document, 64K characters that JSON may escape to six bytes each.
 */

import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./env";
import { STYLE } from "./pages";
import { PANEL_PREFIX } from "./util";

export const BODY_LIMIT = 512 * 1024;

/**
 * The policy for the pages this Worker writes. They run no script at all, so
 * script-src is 'none' (and so is everything else not named here). Styling is
 * the one stylesheet in pages.ts, admitted by its hash rather than by
 * 'unsafe-inline' or a nonce: the sheet is a constant, so its hash is too,
 * no page carries a style="" attribute or a handler, and a test fails if that
 * changes. Change the sheet and the hash follows on its own.
 *
 * form-action names where the forms end up: this site, and the two Stripe
 * hosts the billing forms are redirected to (Chrome applies form-action to
 * the redirect after a post, so 'self' alone would break checkout and the
 * billing portal). Google sign-in and Drive connect are plain links, which
 * form-action does not govern.
 */
export const FORM_ACTION_HOSTS = ["https://checkout.stripe.com", "https://billing.stripe.com"];

let pageCsp: Promise<string> | undefined;

export function pagePolicy(): Promise<string> {
  pageCsp ??= (async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return [
      "default-src 'none'",
      "script-src 'none'",
      `style-src 'sha256-${hash}'`,
      `form-action 'self' ${FORM_ACTION_HOSTS.join(" ")}`,
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  })();
  return pageCsp;
}

const HSTS = "max-age=31536000; includeSubDomains";

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  // A WebSocket upgrade carries the socket on the Response object itself;
  // rebuilding it to add headers would drop the socket.
  if (c.res.status === 101) return;
  const relayed = c.req.path.startsWith(PANEL_PREFIX);
  const extra: [string, string][] = [
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
  ];
  // A handler that already set its own Referrer-Policy chose it deliberately
  // (panel-host.ts's ticket-bearing redirects want no-referrer, stricter than
  // the same-origin default below), so it is never overwritten.
  if (!c.res.headers.has("Referrer-Policy")) extra.push(["Referrer-Policy", "same-origin"]);
  if (c.env.PUBLIC_URL.startsWith("https://")) extra.push(["Strict-Transport-Security", HSTS]);
  const type = c.res.headers.get("Content-Type") ?? "";
  if (!relayed && type.startsWith("text/html")) {
    // A handler that set its own policy chose it deliberately; like the
    // Referrer-Policy above, it is never overwritten.
    if (!c.res.headers.has("Content-Security-Policy")) extra.push(["Content-Security-Policy", await pagePolicy()]);
    // An account page names a person; a shared computer's back button should not show it.
    if (!c.res.headers.has("Cache-Control")) extra.push(["Cache-Control", "no-store"]);
  }
  try {
    for (const [name, value] of extra) c.res.headers.set(name, value);
  } catch {
    // A response straight from fetch() or a Durable Object has immutable
    // headers; a copy of it does not.
    const copy = new Response(c.res.body, c.res);
    for (const [name, value] of extra) copy.headers.set(name, value);
    c.res = copy;
  }
};

const capped = bodyLimit({
  maxSize: BODY_LIMIT,
  onError: (c) => c.json({ error: "too_large", limit_bytes: BODY_LIMIT }, 413),
});

export const bodyCap: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/proxy/")) return next();
  return capped(c, next);
};
