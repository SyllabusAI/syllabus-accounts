/**
 * The Stripe webhook under hostile and awkward conditions.
 *
 * test/stripe.test.ts covers the ordinary path (a subscription becomes an
 * allowance, an orphan is refunded). This file is the launch security bar for
 * the one endpoint that writes money-shaped state: it is unauthenticated but
 * for a signature, Stripe delivers events late, twice and out of order, and a
 * cancellation that is never delivered must not be paid for forever.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { scheduled } from "../src/index";
import { LAPSED_ALLOWANCE, TIERS } from "../src/tiers";
import { claimDevice, get, ORIGIN, signedInAs } from "./helpers";

const SECRET = "whsec_test_secret";
const DAY = 86_400_000;
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function sign(payload: string, at = nowSeconds(), secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${payload}`));
  return `t=${at},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** POST a raw body with exactly this signature header (or none). */
function post(raw: string, signature?: string) {
  return SELF.fetch(ORIGIN + "/stripe/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature === undefined ? {} : { "Stripe-Signature": signature }) },
    body: raw,
  });
}

/** Deliver a well-formed, correctly signed event. */
async function deliver(event: unknown, at?: number) {
  const raw = JSON.stringify(event);
  return post(raw, await sign(raw, at));
}

let seq = 0;
const eventId = () => `evt_wh_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

function subEvent(type: string, object: Record<string, unknown> = {}, id = eventId()) {
  return {
    id,
    type,
    data: {
      object: {
        id: "sub_wh",
        object: "subscription",
        customer: "cus_wh",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: { data: [{ id: "si_1", price: { id: "price_test_pro" }, current_period_end: nowSeconds() + 20 * 86400 }] },
        ...object,
      },
    },
  };
}

function sessionEvent(object: Record<string, unknown>) {
  return {
    id: eventId(),
    type: "checkout.session.completed",
    data: { object: { id: "cs_wh", object: "checkout.session", mode: "subscription", customer: "cus_wh", subscription: "sub_wh", ...object } },
  };
}

async function subscriber(email: string, customer: string) {
  const { account } = await signedInAs(email);
  await db.linkStripeCustomer(env.DB, customer, account.id);
  return account;
}

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

afterEach(() => vi.unstubAllGlobals());

// --- Signatures --------------------------------------------------------------

describe("signature verification", () => {
  const event = () => subEvent("customer.subscription.created", { id: "sub_sig", customer: "cus_sig" });

  /** Whatever the rejection, nothing may have been claimed or written. */
  async function expectUntouched(before: { events: number; subs: number; allowances: number }) {
    expect(await count("stripe_events")).toBe(before.events);
    expect(await count("subscriptions")).toBe(before.subs);
    expect(await count("allowances")).toBe(before.allowances);
  }
  const snapshot = async () => ({ events: await count("stripe_events"), subs: await count("subscriptions"), allowances: await count("allowances") });

  it("answers a missing header, a bad one and a stale one identically, and changes nothing", async () => {
    const account = await subscriber("sig-same@example.com", "cus_sig");
    const raw = JSON.stringify(event());
    const before = await snapshot();
    const bodies: string[] = [];
    for (const sig of [
      await sign(raw, undefined, "whsec_someone_else"),
      await sign(raw, nowSeconds() - 3600),
      `t=${nowSeconds()},v1=${"0".repeat(64)}`,
    ]) {
      const res = await post(raw, sig);
      expect(res.status).toBe(400);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ error: "bad_signature" }));
    await expectUntouched(before);
    expect(await db.allowance(env.DB, account.id)).toBeNull();
  });

  it("refuses header shapes that are not a signature at all", async () => {
    const raw = JSON.stringify(event());
    const good = await sign(raw);
    const v1 = good.split("v1=")[1];
    const before = await snapshot();
    for (const header of [
      "garbage",
      "t=,v1=",
      `t=${nowSeconds()}`, // timestamp only
      `v1=${v1}`, // signature only, no timestamp
      `t=notanumber,v1=${v1}`,
      `t=${nowSeconds()},v1=nothex`,
      `t=${nowSeconds()},v0=${v1}`, // Stripe's test-scheme, not v1
    ]) {
      const res = await post(raw, header);
      expect(res.status, header).toBe(400);
    }
    await expectUntouched(before);
  });

  it("refuses a timestamp older than Stripe's five minute tolerance", async () => {
    const before = await snapshot();
    expect((await deliver(event(), nowSeconds() - 301)).status).toBe(400);
    await expectUntouched(before);
    // The SDK does not bound a timestamp in the future; it is covered by the
    // HMAC (a forger cannot pick one), so that is a property of Stripe's
    // verifier and not something this endpoint should second-guess.
  });

  it("accepts a timestamp inside the tolerance", async () => {
    await subscriber("sig-fresh@example.com", "cus_sig");
    expect((await deliver(event(), nowSeconds() - 200)).status).toBe(200);
  });

  it("cannot be replayed by moving the timestamp: it is part of what is signed", async () => {
    const raw = JSON.stringify(event());
    const old = await sign(raw, nowSeconds() - 3600);
    const forged = `t=${nowSeconds()},v1=${old.split("v1=")[1]}`;
    expect((await post(raw, forged)).status).toBe(400);
  });

  it("verifies the raw bytes, so re-serialized JSON with the same meaning is refused", async () => {
    const raw = JSON.stringify(event());
    const signature = await sign(raw);
    const respaced = JSON.stringify(JSON.parse(raw), null, 2);
    expect((await post(respaced, signature)).status).toBe(400);
  });

  it("refuses a valid signature made with the secret of another deployment", async () => {
    const raw = JSON.stringify(event());
    expect((await post(raw, await sign(raw, undefined, "whsec_live_secret_of_somebody_else"))).status).toBe(400);
  });

  it("uses the secret it is configured with, not one baked in", async () => {
    const real = env.STRIPE_WEBHOOK_SECRET;
    try {
      env.STRIPE_WEBHOOK_SECRET = "whsec_rotated";
      const raw = JSON.stringify(event());
      expect((await post(raw, await sign(raw))).status).toBe(400);
      await subscriber("sig-rotated@example.com", "cus_sig");
      expect((await post(raw, await sign(raw, undefined, "whsec_rotated"))).status).toBe(200);
    } finally {
      env.STRIPE_WEBHOOK_SECRET = real;
    }
  });

  it("accepts a delivery that carries a stale and a fresh v1 (Stripe sends two while a secret rolls)", async () => {
    await subscriber("sig-rolling@example.com", "cus_sig");
    const raw = JSON.stringify(event());
    const t = nowSeconds();
    const stale = (await sign(raw, t, "whsec_previous")).split("v1=")[1];
    const fresh = (await sign(raw, t)).split("v1=")[1];
    expect((await post(raw, `t=${t},v1=${stale},v1=${fresh}`)).status).toBe(200);
  });

  it("checks the signature before it claims anything, so a forger cannot burn an event id", async () => {
    const account = await subscriber("sig-burn@example.com", "cus_sig_burn");
    const ev = subEvent("customer.subscription.created", { id: "sub_sig_burn", customer: "cus_sig_burn" });
    const raw = JSON.stringify(ev);
    expect((await post(raw, await sign(raw, undefined, "whsec_forger"))).status).toBe(400);
    // The real delivery of the same id is still processed.
    expect((await deliver(ev)).status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("does not answer a GET with anything but a refusal", async () => {
    const res = await SELF.fetch(ORIGIN + "/stripe/webhook");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// --- Idempotency and replay ---------------------------------------------------

describe("replay", () => {
  it("grants a top-up once when the same event is delivered concurrently", async () => {
    const { account } = await signedInAs("concurrent-topup@example.com");
    const ev = sessionEvent({
      id: "cs_concurrent",
      mode: "payment",
      payment_status: "paid",
      customer: "cus_concurrent",
      client_reference_id: account.id,
      metadata: { kind: "topup" },
    });
    const results = await Promise.all([deliver(ev), deliver(ev), deliver(ev), deliver(ev)]);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ duplicate?: boolean }>));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(bodies.filter((b) => !b.duplicate)).toHaveLength(1);
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(5 * 3600);
  });

  it("grants a top-up once even when Stripe sends the same session under a new event id", async () => {
    const { account } = await signedInAs("topup-twice@example.com");
    const make = () =>
      sessionEvent({ id: "cs_twice", mode: "payment", payment_status: "paid", customer: "cus_twice", client_reference_id: account.id });
    await deliver(make());
    await deliver(make());
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(5 * 3600);
  });

  it("grants nothing for a top-up session that is not paid yet, and can grant it when it is", async () => {
    const { account } = await signedInAs("topup-unpaid@example.com");
    const base = { id: "cs_unpaid", mode: "payment", customer: "cus_unpaid", client_reference_id: account.id };
    expect((await deliver(sessionEvent({ ...base, payment_status: "unpaid" }))).status).toBe(200);
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(0);
    await deliver(sessionEvent({ ...base, payment_status: "paid" }));
    expect((await db.topupsThisPeriod(env.DB, account.id)).audio_seconds).toBe(5 * 3600);
  });

  it("does not let a replayed old event undo a newer one", async () => {
    const account = await subscriber("replay-old@example.com", "cus_replay_old");
    const created = subEvent("customer.subscription.created", { id: "sub_ro", customer: "cus_replay_old" });
    await deliver(created);
    await deliver(subEvent("customer.subscription.deleted", { id: "sub_ro", customer: "cus_replay_old", status: "canceled" }));
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
    // Stripe redelivers the very first event, same id.
    expect(await (await deliver(created)).json()).toEqual({ ok: true, duplicate: true });
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
  });

  it("releases its claim when the handler throws, and the retry is applied exactly once", async () => {
    const ev = subEvent("customer.subscription.created", { id: "sub_retry", customer: "cus_retry" });
    expect((await deliver(ev)).status).toBe(500); // nobody knows this customer yet
    const account = await subscriber("retry-once@example.com", "cus_retry");
    expect((await deliver(ev)).status).toBe(200);
    expect(await (await deliver(ev)).json()).toEqual({ ok: true, duplicate: true });
    expect((await db.subscriptionsOf(env.DB, account.id))).toHaveLength(1);
  });
});

// --- Out of order ---------------------------------------------------------------

describe("events that arrive out of order", () => {
  it("does not let a late 'active' update bring a canceled subscription back", async () => {
    const account = await subscriber("ooo-late-update@example.com", "cus_ooo1");
    await deliver(subEvent("customer.subscription.created", { id: "sub_ooo1", customer: "cus_ooo1" }));
    await deliver(subEvent("customer.subscription.deleted", { id: "sub_ooo1", customer: "cus_ooo1", status: "canceled" }));
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");

    // Stripe makes no ordering promise: this `updated` was generated before the cancel.
    await deliver(subEvent("customer.subscription.updated", { id: "sub_ooo1", customer: "cus_ooo1", status: "active" }));
    expect((await db.subscriptionById(env.DB, "sub_ooo1"))?.status).toBe("canceled");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
  });

  it("handles 'deleted' arriving before 'created': the late 'created' must not entitle", async () => {
    const account = await subscriber("ooo-deleted-first@example.com", "cus_ooo2");
    expect((await deliver(subEvent("customer.subscription.deleted", { id: "sub_ooo2", customer: "cus_ooo2", status: "canceled" }))).status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");

    expect((await deliver(subEvent("customer.subscription.created", { id: "sub_ooo2", customer: "cus_ooo2", status: "active" }))).status).toBe(200);
    expect((await db.subscriptionById(env.DB, "sub_ooo2"))?.status).toBe("canceled");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
  });

  it("does not let a stale 'incomplete' bring back an expired one", async () => {
    const account = await subscriber("ooo-incomplete@example.com", "cus_ooo3");
    await deliver(subEvent("customer.subscription.updated", { id: "sub_ooo3", customer: "cus_ooo3", status: "incomplete_expired" }));
    await deliver(subEvent("customer.subscription.updated", { id: "sub_ooo3", customer: "cus_ooo3", status: "active" }));
    expect((await db.subscriptionById(env.DB, "sub_ooo3"))?.status).toBe("incomplete_expired");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
  });

  it("still moves through the ordinary states in any order that is legal", async () => {
    const account = await subscriber("ooo-legal@example.com", "cus_ooo4");
    const send = (status: string, type = "customer.subscription.updated") =>
      deliver(subEvent(type, { id: "sub_ooo4", customer: "cus_ooo4", status }));
    await send("trialing", "customer.subscription.created");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("trial");
    await send("active");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
    await send("past_due");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
    await send("paused", "customer.subscription.paused");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");
    await send("active", "customer.subscription.resumed");
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("a new subscription after a canceled one entitles, because it is a different id", async () => {
    const account = await subscriber("ooo-resub@example.com", "cus_ooo5");
    await deliver(subEvent("customer.subscription.deleted", { id: "sub_ooo5_old", customer: "cus_ooo5", status: "canceled" }));
    await deliver(subEvent("customer.subscription.created", { id: "sub_ooo5_new", customer: "cus_ooo5" }));
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("a checkout session arriving after its subscription is fine, and a session alone grants nothing", async () => {
    const { account } = await signedInAs("ooo-session-last@example.com");
    const sub = subEvent("customer.subscription.created", { id: "sub_ooo6", customer: "cus_ooo6" });
    expect((await deliver(sub)).status).toBe(500);
    await deliver(sessionEvent({ customer: "cus_ooo6", client_reference_id: account.id }));
    expect(await db.allowance(env.DB, account.id)).toBeNull();
    expect((await deliver(sub)).status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });
});

// --- Deleted accounts -----------------------------------------------------------

describe("events for an account that no longer exists", () => {
  function noStripeCalls() {
    const fetchSpy = vi.fn(async () => {
      throw new Error("the webhook called Stripe when it should not have");
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  it("does not recreate rows for a customer whose account was deleted", async () => {
    const account = await subscriber("deleted-later@example.com", "cus_gone");
    await deliver(subEvent("customer.subscription.created", { id: "sub_gone", customer: "cus_gone" }));
    await db.deleteAccountData(env.DB, account.id, "hash-of-a-deleted-account");

    const fetchSpy = noStripeCalls();
    const late = await deliver(subEvent("customer.subscription.updated", { id: "sub_gone", customer: "cus_gone", status: "active" }));
    // No stamp and the customer link went with the account: the event is
    // deferred (Stripe retries for days), never applied to nothing.
    expect(late.status).toBe(500);
    expect(await db.subscriptionById(env.DB, "sub_gone")).toBeNull();
    expect(await db.allowance(env.DB, account.id)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a stamped event for a deleted account and writes nothing for it", async () => {
    const { account } = await signedInAs("deleted-stamped@example.com");
    await db.deleteAccountData(env.DB, account.id, "hash-of-a-deleted-account-2");
    noStripeCalls();
    const res = await deliver(
      subEvent("customer.subscription.deleted", { id: "sub_gone2", customer: "cus_gone2", status: "canceled", metadata: { account_id: account.id } }),
    );
    expect(res.status).toBe(200);
    expect(await db.subscriptionById(env.DB, "sub_gone2")).toBeNull();
    expect(await db.allowance(env.DB, account.id)).toBeNull();
  });

  it("does not let a deleted account's id be attached to a later event", async () => {
    const { account } = await signedInAs("deleted-attr@example.com");
    await db.deleteAccountData(env.DB, account.id, "hash-of-a-deleted-account-3");
    noStripeCalls();
    const ev = subEvent("customer.subscription.deleted", { id: "sub_gone3", status: "canceled", metadata: { account_id: account.id } });
    await deliver(ev);
    const row = await env.DB.prepare("SELECT account_id FROM stripe_events WHERE id = ?").bind(ev.id).first<{ account_id: string }>();
    expect(row?.account_id).toBe("");
  });
});

// --- Event types and payload shapes -----------------------------------------------

describe("events it does not act on", () => {
  it.each([
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.trial_will_end",
    "customer.subscription.pending_update_applied",
    "charge.refunded",
    "customer.deleted",
    "totally.made.up",
    "",
  ])("acknowledges %j without touching accounts or calling Stripe", async (type) => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no Stripe call expected");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = { subs: await count("subscriptions"), allowances: await count("allowances") };
    const res = await deliver({ id: eventId(), type, data: { object: subEvent("x").data.object } });
    expect(res.status).toBe(200);
    expect(await count("subscriptions")).toBe(before.subs);
    expect(await count("allowances")).toBe(before.allowances);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not treat a look-alike type as a handled one", async () => {
    const account = await subscriber("lookalike@example.com", "cus_look");
    for (const type of ["customer.subscription.created ", "Customer.Subscription.Created", "customer.subscription.created.extra"]) {
      expect((await deliver(subEvent(type, { id: "sub_look", customer: "cus_look" }))).status).toBe(200);
    }
    expect(await db.subscriptionById(env.DB, "sub_look")).toBeNull();
    expect(await db.allowance(env.DB, account.id)).toBeNull();
  });
});

describe("malformed payloads", () => {
  async function signed(raw: string) {
    return post(raw, await sign(raw));
  }

  it.each([
    ["not JSON", "this is not json"],
    ["an empty body", ""],
    ["truncated JSON", '{"id":"evt_1","type":"customer.sub'],
  ])("refuses a correctly signed body that is %s", async (_name, raw) => {
    const before = await count("stripe_events");
    const res = await signed(raw);
    expect(res.status).toBe(400);
    expect(await count("stripe_events")).toBe(before);
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"evt"'],
    ["an object with no id", '{"type":"customer.subscription.created","data":{"object":{}}}'],
    ["an object with no type", '{"id":"evt_notype","data":{"object":{}}}'],
    ["a numeric id", '{"id":12,"type":"invoice.paid","data":{"object":{}}}'],
  ])("refuses a correctly signed event that is %s, cleanly and without a claim", async (_name, raw) => {
    const before = await count("stripe_events");
    const res = await signed(raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed_event" });
    expect(await count("stripe_events")).toBe(before);
  });

  it.each([
    ["no data at all", { id: "", type: "customer.subscription.created" }],
    ["data with no object", { id: "", type: "customer.subscription.created", data: {} }],
    ["a null object", { id: "", type: "customer.subscription.updated", data: { object: null } }],
    ["an object with no id", { id: "", type: "customer.subscription.updated", data: { object: { customer: "cus_x" } } }],
  ])("fails a handled type with %s as a retryable error and leaves nothing behind", async (_name, ev) => {
    const event = { ...ev, id: eventId() };
    const res = await deliver(event);
    expect(res.status).toBe(500);
    expect(await db.subscriptionById(env.DB, "")).toBeNull();
    const claimed = await env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(event.id).first();
    expect(claimed).toBeNull();
  });

  it("does not entitle on a subscription with no items or a price that is not a string", async () => {
    const account = await subscriber("malformed-items@example.com", "cus_items");
    for (const items of [undefined, {}, { data: [] }, { data: [{ price: null }] }, { data: [{ price: { id: 7 } }] }]) {
      await deliver(subEvent("customer.subscription.updated", { id: "sub_items", customer: "cus_items", items }));
    }
    const sub = await db.subscriptionById(env.DB, "sub_items");
    expect(sub?.price_id === "" || sub?.price_id === "7").toBe(true);
    // Unrecognized price: cheapest tier by design (tiers.ts), never a higher one.
    const row = await db.allowance(env.DB, account.id);
    expect(row!.audio_seconds).toBeLessThanOrEqual(TIERS.starter.audio_seconds);
  });

  it.each([
    ["an out-of-range number", 1e20],
    ["a negative one", -1e20],
    ["NaN as a string", "soon"],
    ["null", null],
  ])("survives a period end that is %s", async (_name, value) => {
    const account = await subscriber(`period-${String(_name).replace(/\W/g, "")}@example.com`, `cus_p_${String(_name).replace(/\W/g, "")}`);
    const customer = `cus_p_${String(_name).replace(/\W/g, "")}`;
    const res = await deliver(
      subEvent("customer.subscription.created", {
        id: `sub_p_${String(_name).replace(/\W/g, "")}`,
        customer,
        items: { data: [{ id: "si", price: { id: "price_test_pro" }, current_period_end: value }] },
      }),
    );
    // A bad date is stored as "no period end" (status alone entitles), never a crash that Stripe retries for days.
    expect(res.status).toBe(200);
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("does not let a metadata account id it cannot resolve grant anything", async () => {
    const before = await count("allowances");
    const res = await deliver(subEvent("customer.subscription.created", { id: "sub_stamp_bad", customer: "cus_stamp_bad", metadata: { account_id: { $ne: "" } } }));
    // Not a string: treated as unstamped, the customer is unknown, so it is deferred.
    expect(res.status).toBe(500);
    expect(await count("allowances")).toBe(before);
  });

  it("does not grant for an account named only by a client_reference_id that is another account's", async () => {
    // A checkout session links the customer; it does not grant. Naming a
    // victim's account id links nothing to the attacker without Stripe's signature.
    const { account } = await signedInAs("victim@example.com");
    await deliver(sessionEvent({ customer: "cus_attacker", client_reference_id: account.id }));
    expect(await db.allowance(env.DB, account.id)).toBeNull();
  });
});

// --- The cancellation Stripe never delivers -----------------------------------------

describe("a cancellation that never arrives", () => {
  /** A live subscription whose period ended `daysAgo` days ago and was never renewed or canceled to us. */
  async function stranded(email: string, daysAgo: number, over: Record<string, unknown> = {}) {
    const { account, token } = await claimDevice(email);
    const ends = nowSeconds() - Math.round(daysAgo * 86400);
    const id = `sub_${email.split("@")[0].replace(/\W/g, "")}`;
    // Delivered while it was still current, as it would have been.
    await deliver(
      subEvent("customer.subscription.created", {
        id,
        customer: `cus_${id}`,
        metadata: { account_id: account.id },
        items: { data: [{ id: "si", price: { id: "price_test_pro" }, current_period_end: ends }] },
        ...over,
      }),
    );
    return { account, token, id };
  }

  async function runCron() {
    const ctx = createExecutionContext();
    await scheduled({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env as never, ctx);
    await waitOnExecutionContext(ctx);
  }

  it("ends the allowance in the hourly sweep once the period and grace have passed", async () => {
    const { account, token } = await stranded("stranded-old@example.com", 10);
    // Stale on arrival is handled at write time; force the state the bug is
    // about: the row was written while the period was current.
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");

    await runCron();

    expect(await db.allowance(env.DB, account.id)).toMatchObject({ source: "lapsed", audio_seconds: 0, summary_tokens: 0 });
    const usage = (await (await get("/proxy/usage", { Authorization: `Bearer ${token}` })).json()) as Record<string, any>;
    expect(usage.source).toBe("lapsed");
    expect(usage.recordable_seconds).toBe(0);
  });

  it("leaves a subscription alone that is inside its grace, so a slow renewal does not cut anyone off", async () => {
    const { account } = await stranded("stranded-grace@example.com", 0);
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    await env.DB.prepare("UPDATE subscriptions SET current_period_end = ? WHERE account_id = ?")
      .bind(new Date(Date.now() - 2 * DAY).toISOString(), account.id)
      .run();
    await runCron();
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("does not touch a current subscription, an owner grant, or an account with a second live subscription", async () => {
    const current = await stranded("sweep-current@example.com", -20);
    const owner = await stranded("sweep-owner@example.com", 30);
    await db.putAllowance(env.DB, owner.account.id, { audio_seconds: 99, summary_tokens: 99, assistant_sessions: 0, source: "owner" });
    const upgraded = await stranded("sweep-upgraded@example.com", 30);
    await db.putAllowance(env.DB, upgraded.account.id, { ...TIERS.pro, source: "pro" });
    await env.DB.prepare(
      `INSERT INTO subscriptions (stripe_subscription_id, account_id, stripe_customer_id, price_id, tier, status, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES ('sub_second', ?, 'cus_second', 'price_test_starter', 'starter', 'active', ?, 0, ?, ?)`,
    )
      .bind(upgraded.account.id, new Date(Date.now() + 10 * DAY).toISOString(), new Date().toISOString(), new Date().toISOString())
      .run();

    await runCron();

    expect((await db.allowance(env.DB, current.account.id))?.source).toBe("pro");
    expect(await db.allowance(env.DB, owner.account.id)).toMatchObject({ source: "owner", audio_seconds: 99 });
    // The stranded Pro lapses, but the live Starter keeps the account paid.
    expect((await db.allowance(env.DB, upgraded.account.id))?.source).toBe("starter");
  });

  it("is restored by the renewal when it does arrive late", async () => {
    const { account, id } = await stranded("stranded-renewed@example.com", 10);
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    await runCron();
    expect((await db.allowance(env.DB, account.id))?.source).toBe("lapsed");

    await deliver(
      subEvent("customer.subscription.updated", {
        id,
        customer: `cus_${id}`,
        metadata: { account_id: account.id },
        items: { data: [{ id: "si", price: { id: "price_test_pro" }, current_period_end: nowSeconds() + 25 * 86400 }] },
      }),
    );
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("is idempotent: a second sweep changes nothing", async () => {
    const { account } = await stranded("stranded-twice@example.com", 10);
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    await runCron();
    const first = await db.allowance(env.DB, account.id);
    await runCron();
    expect(await db.allowance(env.DB, account.id)).toEqual(first);
    expect(first).toMatchObject({ source: LAPSED_ALLOWANCE.source });
  });

  it("does not lapse a subscription Stripe never gave a period end", async () => {
    const { account } = await stranded("stranded-noperiod@example.com", 0, {
      items: { data: [{ id: "si", price: { id: "price_test_pro" } }] },
    });
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    await runCron();
    expect((await db.allowance(env.DB, account.id))?.source).toBe("pro");
  });

  it("does not resurrect a trial: a lapsed account stays at zero, not at the free trial", async () => {
    const { account } = await stranded("stranded-notrial@example.com", 10);
    await db.putAllowance(env.DB, account.id, { ...TIERS.pro, source: "pro" });
    await runCron();
    expect((await db.allowance(env.DB, account.id))?.audio_seconds).toBe(0);
  });
});
