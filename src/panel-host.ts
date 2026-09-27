/**
 * The panel host: relayed panels on an origin of their own (PANEL_ORIGIN).
 *
 * A relayed panel page is HTML the Mac wrote, and anybody holding that Mac's
 * device token can be the Mac. Served at PUBLIC_URL/p/<device>/ it is
 * same-origin with /account, /device/approve, /devices/:id/revoke,
 * /drive/disconnect and the billing forms, so a script in it can read those
 * pages and post their forms with a correct Origin header, which is exactly
 * what browserOnly() and sameOrigin() were meant to stop. On a separate
 * origin the browser itself keeps the two apart.
 *
 * With PANEL_ORIGIN set:
 *
 *   PUBLIC_URL/p/<device>/...     never serves panel content. A signed-in
 *                                 owner is handed across with a ticket;
 *                                 anyone else gets what they got before.
 *   PANEL_ORIGIN/p/<device>/_auth?t=<ticket>
 *                                 spends the ticket once, sets this host's
 *                                 own panel cookie, and sends the browser on
 *                                 to the panel with the ticket gone from the
 *                                 address.
 *   PANEL_ORIGIN/p/<device>/...   the relay, for whoever the panel cookie
 *                                 names, if they still own the device.
 *   PANEL_ORIGIN/anything else    404. No account page, no billing, no
 *                                 device route, no /relay/connect, and no
 *                                 bearer tokens: the Mac still connects to
 *                                 PUBLIC_URL.
 *
 * The account session cookie is host-only (session.ts sets no Domain), so it
 * never reaches this host. That is why the ticket exists: it is the one thing
 * that crosses, and it is worth nothing after one use or 60 seconds.
 *
 * Both the ticket and the panel cookie are HMAC-SHA256 under keys derived
 * from SESSION_SECRET with labels of their own, so neither is ever the same
 * bytes as anything the session cookie signs, and one cannot stand in for the
 * other.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import * as db from "./db";
import type { Account, AppEnv, Bindings } from "./env";
import { page } from "./pages";
import { forward, ownedDevice, panelRequest, relayAllowed } from "./relay";
import { escapeHtml as h, fromBase64Url, PANEL_PREFIX, randomId, toBase64Url } from "./util";

/** How long a ticket is good for. It only has to survive two redirects. */
export const TICKET_SECONDS = 60;
/** How long the panel host remembers a viewer before sending them back for a fresh ticket. */
export const PANEL_COOKIE_HOURS = 12;
export const PANEL_COOKIE = "syllabus_panel";
/** The path segment the ticket is spent at. The panel serves nothing by this name (relayAllowed). */
export const AUTH_SEGMENT = "_auth";

const TICKET_LABEL = "syllabus panel ticket v1";
const COOKIE_LABEL = "syllabus panel cookie v1";

// --- Configuration -------------------------------------------------------------

/**
 * PANEL_ORIGIN as this Worker will use it: "" when unset, the normalized
 * origin when it is usable, and null when it is set but unusable.
 *
 * Null is fail-closed on purpose. A PANEL_ORIGIN that is PUBLIC_URL's own
 * host would put the panel right back on the account origin, and one that is
 * a parent or a subdomain of it lets the panel's scripts set cookies the
 * account host receives; serving panels anyway would look like the fix while
 * being none of it. The caller refuses to relay instead, so a bad value is
 * loud rather than quietly unsafe.
 */
export function panelOrigin(env: Pick<Bindings, "PUBLIC_URL" | "PANEL_ORIGIN">): string | null {
  const raw = (env.PANEL_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let panel: URL;
  let account: URL;
  try {
    panel = new URL(raw);
    account = new URL(env.PUBLIC_URL);
  } catch {
    return null;
  }
  // An origin and only an origin: no path, query, fragment or credentials.
  if (panel.origin !== raw.toLowerCase() && panel.origin !== raw) return null;
  if (panel.username || panel.password) return null;
  // https, unless the account host itself is plain http (local development).
  if (panel.protocol !== "https:" && !(panel.protocol === "http:" && account.protocol === "http:")) return null;
  const p = panel.hostname.toLowerCase();
  const a = account.hostname.toLowerCase();
  if (p === a || p.endsWith("." + a) || a.endsWith("." + p)) return null;
  return panel.origin;
}

// --- Keys ----------------------------------------------------------------------

async function derivedKey(secret: string, label: string): Promise<CryptoKey> {
  if (!secret) throw new Error("SESSION_SECRET is not set; refusing to sign or read a panel ticket");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(label));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The panel cookie's signing secret, as the string hono's signed cookies take. */
async function cookieSecret(secret: string): Promise<string> {
  const key = await derivedKey(secret, COOKIE_LABEL);
  const raw = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("cookie"));
  return toBase64Url(new Uint8Array(raw));
}

// --- Tickets -------------------------------------------------------------------

/** What a ticket says: whose, for which device, spent once by nonce, until when, and where to land. */
export type Ticket = { v: 1; a: string; d: string; n: string; e: number; p: string };

/** `<payload>.<mac>`, both base64url. */
export async function mintTicket(
  secret: string,
  accountId: string,
  deviceId: string,
  landing: string,
  nowMs = Date.now(),
): Promise<string> {
  const ticket: Ticket = { v: 1, a: accountId, d: deviceId, n: randomId(18), e: nowMs + TICKET_SECONDS * 1000, p: safeLanding(landing) };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(ticket)));
  const mac = await crypto.subtle.sign("HMAC", await derivedKey(secret, TICKET_LABEL), new TextEncoder().encode(payload));
  return payload + "." + toBase64Url(new Uint8Array(mac));
}

/**
 * The ticket, if it is genuine, unexpired and for this device; else why not.
 * Says nothing about whether it was spent already; spendTicket() does.
 */
export async function readTicket(
  secret: string,
  text: string,
  deviceId: string,
  nowMs = Date.now(),
): Promise<{ ticket: Ticket } | { error: string }> {
  const parts = text.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || text.length > 2048) return { error: "malformed" };
  let mac: Uint8Array;
  try {
    mac = fromBase64Url(parts[1]);
  } catch {
    return { error: "malformed" };
  }
  // crypto.subtle.verify compares in constant time.
  const genuine = await crypto.subtle.verify(
    "HMAC",
    await derivedKey(secret, TICKET_LABEL),
    mac,
    new TextEncoder().encode(parts[0]),
  );
  if (!genuine) return { error: "forged" };
  let ticket: Ticket;
  try {
    ticket = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as Ticket;
  } catch {
    return { error: "malformed" };
  }
  if (ticket.v !== 1 || typeof ticket.a !== "string" || typeof ticket.d !== "string" || typeof ticket.n !== "string" || typeof ticket.e !== "number") {
    return { error: "malformed" };
  }
  if (ticket.e <= nowMs || ticket.e - nowMs > TICKET_SECONDS * 1000 + 5000) return { error: "expired" };
  if (ticket.d !== deviceId) return { error: "wrong_device" };
  return { ticket };
}

/** Spend a ticket's nonce. False if it was spent already. */
export async function spendTicket(database: D1Database, ticket: Ticket, nowMs = Date.now()): Promise<boolean> {
  const res = await database
    .prepare("INSERT OR IGNORE INTO panel_tickets (nonce, expires_at) VALUES (?, ?)")
    .bind(ticket.n, new Date(ticket.e).toISOString())
    .run();
  // The table only ever needs the tickets that could still arrive.
  await database.prepare("DELETE FROM panel_tickets WHERE expires_at < ?").bind(new Date(nowMs).toISOString()).run();
  return (res.meta.changes ?? 0) === 1;
}

/** Where under /p/<device> a ticket may land: a path of ours, never another host. */
function safeLanding(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  return "/";
}

/**
 * The account host's half: an owner asked for their panel at PUBLIC_URL, so
 * send them to the panel host with a ticket. The caller has already checked
 * the session and that this account owns the device.
 */
export async function handOff(c: Context<AppEnv>, origin: string, account: Account, deviceId: string, landing: string): Promise<Response> {
  const ticket = await mintTicket(c.env.SESSION_SECRET, account.id, deviceId, landing);
  const res = c.redirect(`${origin}${PANEL_PREFIX}${deviceId}/${AUTH_SEGMENT}?t=${encodeURIComponent(ticket)}`, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

// --- The panel cookie ----------------------------------------------------------

type PanelCookie = { a: string; d: string; v: number; t: number };

export function panelCookiePath(deviceId: string): string {
  return PANEL_PREFIX + deviceId + "/";
}

async function setPanelCookie(c: Context<AppEnv>, origin: string, account: Account, deviceId: string): Promise<void> {
  const data: PanelCookie = { a: account.id, d: deviceId, v: account.token_version ?? 0, t: Date.now() };
  // Host-only (no Domain), so it belongs to the panel host and nothing else,
  // and scoped to this one device's panel.
  await setSignedCookie(c, PANEL_COOKIE, JSON.stringify(data), await cookieSecret(c.env.SESSION_SECRET), {
    path: panelCookiePath(deviceId),
    httpOnly: true,
    secure: origin.startsWith("https://"),
    // Lax, not Strict: the browser arrives here by a redirect chain that
    // started on the account host, which Strict would count as cross-site
    // all the way to the panel, and the cookie set here would not be sent.
    sameSite: "Lax",
    maxAge: PANEL_COOKIE_HOURS * 3600,
  });
}

/** The account a valid panel cookie names for this device, if it still may see it. */
async function panelViewer(c: Context<AppEnv>, deviceId: string): Promise<Account | null> {
  // Two cookies of the same name means one of them was put there by
  // something other than this host's own Set-Cookie. Trust neither.
  const header = c.req.header("Cookie") ?? "";
  if (countCookie(header, PANEL_COOKIE) !== 1) return null;
  const raw = await getSignedCookie(c, await cookieSecret(c.env.SESSION_SECRET), PANEL_COOKIE);
  if (!raw) return null;
  let data: PanelCookie;
  try {
    data = JSON.parse(raw) as PanelCookie;
  } catch {
    return null;
  }
  if (typeof data.a !== "string" || data.d !== deviceId || typeof data.t !== "number") return null;
  if (Date.now() - data.t > PANEL_COOKIE_HOURS * 3600 * 1000) return null;
  const account = await db.accountById(c.env.DB, data.a);
  // "Sign out every Mac" bumps token_version; a panel cookie from before it is done too.
  if (!account || (account.token_version ?? 0) !== data.v) return null;
  return account;
}

/** How many cookies named `name` a Cookie header carries. */
export function countCookie(header: string, name: string): number {
  return header.split(";").filter((part) => part.trim().split("=")[0] === name).length;
}

// --- Headers -------------------------------------------------------------------

/**
 * Every panel host response. The panel's pages run inline scripts and
 * styles of their own, so there is no script-src here to break them; what
 * the policy does say is that nobody may frame the panel, nothing may change
 * its base URL, and its forms post only to itself.
 */
export const PANEL_CSP = ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join("; ");

function withPanelHeaders(res: Response, origin: string): Response {
  // A Durable Object's response has immutable headers; a copy does not.
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", PANEL_CSP);
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "same-origin");
  // No window of the account host keeps a handle on a panel, or the reverse.
  out.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  out.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  out.headers.set("X-Robots-Tag", "noindex");
  if (origin.startsWith("https://")) out.headers.set("Strict-Transport-Security", "max-age=31536000");
  return out;
}

/** For a POST on the panel host: from the panel host. The account host does not count. */
function fromPanelHost(c: Context<AppEnv>, origin: string): boolean {
  const from = c.req.header("Origin") ?? "";
  if (from) return from === origin;
  return (c.req.header("Referer") ?? "").startsWith(origin + "/");
}

// --- The panel host's app ------------------------------------------------------

export const panelHost = new Hono<AppEnv>();

panelHost.use("*", async (c, next) => {
  // Nobody is signed in here by the account's means: no session cookie
  // arrives on this host, and a bearer token is not read at all.
  c.set("account", null);
  c.set("device", null);
  c.set("authKind", null);
  await next();
  c.res = withPanelHeaders(c.res, panelOrigin(c.env) || "");
});

panelHost.get(`/p/:device/${AUTH_SEGMENT}`, async (c) => {
  const origin = panelOrigin(c.env) as string;
  const deviceId = c.req.param("device");
  const refused = (why: string) => {
    console.log(`refused a panel ticket for device ${deviceId}: ${why}`);
    const res = c.html(
      page(
        "Sign in",
        `<p>That link to your Syllabus panel has already been used or has expired.</p>
         <p><a href="${h(c.env.PUBLIC_URL + PANEL_PREFIX + encodeURIComponent(deviceId) + "/")}">Open the panel again</a></p>`,
      ),
      403,
    );
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const read = await readTicket(c.env.SESSION_SECRET, c.req.query("t") ?? "", deviceId);
  if ("error" in read) return refused(read.error);
  const { ticket } = read;
  const device = await db.deviceById(c.env.DB, deviceId);
  if (!device || device.account_id !== ticket.a) return refused("the device is not that account's");
  const account = await db.accountById(c.env.DB, ticket.a);
  if (!account) return refused("no such account");
  if (!(await spendTicket(c.env.DB, ticket))) return refused("already spent");
  await setPanelCookie(c, origin, account, deviceId);
  const res = c.redirect(PANEL_PREFIX + deviceId + safeLanding(ticket.p), 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
});

panelHost.all("/p/:device", (c) => c.redirect(c.req.path + "/" + new URL(c.req.url).search));

panelHost.all("/p/:device/*", async (c) => {
  const origin = panelOrigin(c.env) as string;
  const deviceId = c.req.param("device");
  const where = panelRequest(c, deviceId);
  const account = await panelViewer(c, deviceId);
  if (!account) {
    // Back to the account host, which signs the person in if it has to and
    // hands them straight back here with a ticket.
    if (where.isPage) return c.redirect(c.env.PUBLIC_URL + where.url.pathname + where.url.search, 302);
    return c.json({ error: "not_signed_in" }, 401);
  }
  if (!relayAllowed(c.req.method, where.rest)) {
    if (where.isApi) return c.json({ error: "not_found" }, 404);
    return c.html(page("Not found", "<p>The panel has no such page.</p>"), 404);
  }
  if (c.req.method !== "GET" && !fromPanelHost(c, origin)) return c.json({ error: "cross_origin" }, 403);
  const device = await ownedDevice(c, account, deviceId, where.isApi);
  if (device instanceof Response) return device;
  return forward(c, account, device, where);
});

panelHost.notFound((c) => c.text("Not found", 404));
panelHost.onError((err, c) => {
  console.log(`panel host error: ${err.message}`);
  return c.text("Something went wrong", 500);
});
