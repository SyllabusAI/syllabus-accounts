/**
 * Syllabus accounts: a Cloudflare Worker with a D1 database.
 *
 * Who is signed in comes from one of two places. A browser carries the
 * session cookie set by the Google sign-in (google.ts). A panel running on
 * somebody's Mac carries a device token as a bearer (devices.ts). Either
 * way the handlers see c.var.account, and a panel also sees c.var.device.
 *
 * Which of the two it was is c.var.authKind, and routes that administer the
 * account rather than serve a panel say so with browserOnly(). Sharing one
 * c.var.account between the two kinds is what let a stolen device token
 * enroll a replacement Mac and remove the one it was stolen from.
 */

import { Hono } from "hono";
import { account } from "./account";
import * as db from "./db";
import { devices, TOKEN_IDLE_DAYS, tokenStanding } from "./devices";
import type { AppEnv, Bindings } from "./env";
import { google } from "./google";
import { accountPage, landing, privacyPage, termsPage } from "./pages";
import { panelHost, panelOrigin } from "./panel-host";
import { proxy } from "./proxy";
import { assistant } from "./assistant";
import { panelUrl, relay, relayState } from "./relay";
import { billing, billingView } from "./billing";
import { settings } from "./settings";
import { stripeHooks } from "./stripe";
import { drive } from "./drive";
import { sweepDriveGrants } from "./drive-keys";
import { bodyCap, securityHeaders } from "./headers";
import { crossSiteGuard, sessionMiddleware } from "./session";
import { DEVICE_TOKEN_PREFIX, sha256Hex } from "./util";
import { log } from "./log";

const app = new Hono<AppEnv>();

// First of all, so that every response, the webhook's included, carries the
// security headers and no handler reads an oversized body (headers.ts).
app.use("*", securityHeaders);
app.use("*", bodyCap);

// Mounted BEFORE the auth middleware, and deliberately.
//
// Stripe carries neither a session cookie nor a device token, so the
// middleware below has nothing to resolve for it. Hono runs handlers in the
// order they were registered, so registering this route first is what keeps
// the auth middleware off it: the webhook proves who it is with Stripe's
// signature over the raw body and with nothing else.
app.route("/", stripeHooks);

app.use("*", async (c, next) => {
  c.set("account", null);
  c.set("device", null);
  c.set("authKind", null);
  const auth = c.req.header("Authorization") ?? "";
  if (auth.startsWith("Bearer " + DEVICE_TOKEN_PREFIX)) {
    const tokenHash = await sha256Hex(auth.slice(7));
    const found = await db.resolveDeviceToken(c.env.DB, tokenHash);
    if (!found) return c.json({ error: "invalid_token" }, 401);
    // Every bearer route passes through here, so this one check covers /me,
    // /settings, /drive/token, /proxy/*, /relay/connect and /device/revoke.
    // Same status and error as any dead token, because the panel already
    // treats a 401 as "forget the token and offer a fresh sign-in"
    // (whoami in intake/account.py); `reason` says which kind of dead.
    const standing = tokenStanding(found.lastUsedAt);
    if (standing === "expired") {
      return c.json(
        {
          error: "invalid_token",
          reason: "token_expired",
          message: `This Mac's sign-in went unused for ${TOKEN_IDLE_DAYS} days and has expired. Sign in again from Syllabus.`,
        },
        401,
        { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token expired"' },
      );
    }
    // Awaited rather than left to waitUntil: it happens once a day per
    // token, and a stamp that lands is what keeps an active Mac signed in.
    if (standing === "touch") await db.touchDeviceToken(c.env.DB, tokenHash);
    c.set("account", found.account);
    c.set("device", found.device);
    c.set("authKind", "device");
    c.executionCtx.waitUntil(db.touchDevice(c.env.DB, found.device.id));
    return next();
  }
  return sessionMiddleware(c, next);
});

// After the auth middleware, which is what says whether a cookie signed this
// request in; before every route, so none can forget to check (session.ts).
app.use("*", crossSiteGuard);

app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/privacy", (c) => c.html(privacyPage()));
app.get("/terms", (c) => c.html(termsPage()));

app.get("/", async (c) => {
  const account = c.get("account");
  if (!account) return c.html(landing());
  const devices = await db.devicesOf(c.env.DB, account.id);
  // Each Mac's relay object knows whether its panel is connected right now.
  const relays = Object.fromEntries(
    await Promise.all(devices.map(async (d) => [d.id, await relayState(c.env, d.id).catch(() => null)] as const)),
  );
  return c.html(
    accountPage(
      account,
      devices,
      await db.driveGrant(c.env.DB, account.id),
      relays,
      c.env.PUBLIC_URL,
      await billingView(c, account.id),
      c.req.query("billing") ?? "",
    ),
  );
});

/** Who am I: for a panel checking its token, or a browser checking its session. */
app.get("/me", (c) => {
  const account = c.get("account");
  if (!account) return c.json({ error: "not_signed_in" }, 401);
  const device = c.get("device");
  return c.json({
    account: { id: account.id, email: account.email, name: account.name },
    device: device ? { id: device.id, name: device.name, profile: device.profile } : null,
  });
});

/** A panel signing itself out: its own token stops working. */
app.post("/device/revoke", async (c) => {
  const device = c.get("device");
  if (!device) return c.json({ error: "not_a_device" }, 401);
  const auth = c.req.header("Authorization") ?? "";
  await db.revokeDeviceToken(c.env.DB, await sha256Hex(auth.slice(7)));
  return c.json({ ok: true });
});

app.route("/", google);
app.route("/", account);
app.route("/", devices);
app.route("/", relay);
app.route("/", settings);
app.route("/", billing);
app.route("/", drive);
app.route("/", proxy);
app.route("/", assistant);

app.notFound((c) => c.text("Not found", 404));
app.onError((err, c) => {
  log(`error: ${err.message}`);
  return c.text("Something went wrong", 500);
});

/**
 * The hourly cron (wrangler.jsonc triggers): housekeeping nobody waits on.
 *
 * Seals any Drive grant not under the current DRIVE_KEY again under it, which
 * is what lets DRIVE_KEY_PREVIOUS be deleted after a rotation
 * (docs/drive-key-rotation.md), and clears rate-limit windows that closed
 * long ago. Both are bounded and idempotent, so a missed or doubled run
 * changes nothing.
 */
export async function scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const sweep = await sweepDriveGrants(env);
      if (sweep.resealed || sweep.unreadable || sweep.remaining) {
        log(
          `drive keys: resealed ${sweep.resealed}, unreadable ${sweep.unreadable}, ` +
            `${sweep.remaining} not yet under the current DRIVE_KEY`,
        );
      }
      await db.sweepRateLimits(env.DB, Math.floor(Date.now() / 1000) - 3600);
    })(),
  );
}

/**
 * Which app answers is decided by the host asked, before anything else runs.
 *
 * With PANEL_ORIGIN set, a request to that host is the panel host's
 * (panel-host.ts) and never reaches a route above: no account page, no
 * billing form, no device route, no session or bearer middleware. Every
 * other host is this app, as it always was. Unset, nothing here changes.
 */
export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const panel = panelOrigin(env);
    if (panel && new URL(request.url).origin === panel) return panelHost.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
  scheduled,
} satisfies ExportedHandler<Bindings>;
// The Durable Object class has to be exported from the entry module.
export { PanelRelay } from "./panel-relay";
