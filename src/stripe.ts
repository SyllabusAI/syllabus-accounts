/**
 * The Stripe webhook: the one thing in this service that writes an allowance.
 *
 *   POST /stripe/webhook   authenticated by Stripe's signature alone
 *
 * Stripe owns the subscription. This endpoint mirrors what Stripe says into
 * `subscriptions`, works out what that entitles with the rules in tiers.ts,
 * and writes the `allowances` row the proxy already enforces. The proxy is
 * unchanged and is still the only enforcement point; this is only what fills
 * in the row it reads.
 *
 * Three things make a webhook different from every other route here:
 *
 * 1. It carries no session cookie and no device token, so it is mounted
 *    before the auth middleware in index.ts and proves who it is with the
 *    signature.
 * 2. The signature covers the RAW body, so the body is read as text and
 *    parsed by Stripe's verifier rather than by Hono.
 * 3. Stripe retries until it gets a 2xx, and delivers the same event twice
 *    even after one. Handling an event twice is how an account silently gets
 *    two months of allowance, so every delivery claims its event id first.
 *
 * Nothing here calls Stripe back, with one exception. Every field stored
 * comes out of the event body, which keeps a delivery to one D1 round trip
 * and means a Stripe outage cannot stop a webhook that has already arrived.
 * The exception is money arriving for an account that was deleted, which
 * nothing else would ever stop: a live subscription is canceled, refunded
 * and its customer removed (endOrphan), and a paid top-up is refunded.
 */

import { Hono, type Context } from "hono";
import Stripe from "stripe";
import * as db from "./db";
import type { AppEnv, Bindings } from "./env";
import { clientAddress, LIMITS, limitedJson, overLimit } from "./limits";
import { allowanceFromSubscription, entitlingSubscription, tierForPrice, TOPUP, TRIAL_ALLOWANCE } from "./tiers";
import { log, logError } from "./log";

export const stripeHooks = new Hono<AppEnv>();

/**
 * A Stripe event is a few kilobytes. This is far above any real one and is
 * here so that an unauthenticated caller cannot make us hold, and HMAC, an
 * arbitrary amount of memory before the signature is even looked at.
 */
const MAX_EVENT_BYTES = 256 * 1024;

/**
 * Allowance sources this webhook will not overwrite.
 *
 * `owner` is granted by hand and is not a tier. Nothing should send a
 * subscription event for it, but the row is the one thing standing between
 * the account that runs this service and a 402, so it is protected rather
 * than trusted to never be touched.
 */
const PROTECTED_SOURCES = new Set(["owner"]);

/** The events that change what somebody is entitled to. Everything else is noted and ignored. */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/** Thrown when a delivery should be retried rather than accepted. */
class RetryLater extends Error {}

stripeHooks.post("/stripe/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    log("stripe: a webhook arrived and STRIPE_WEBHOOK_SECRET is not set; refusing it");
    return c.json({ error: "stripe_not_configured" }, 503);
  }
  const signature = c.req.header("stripe-signature") ?? "";
  if (!signature) return c.json({ error: "missing_signature" }, 400);
  // Before the body is read or the signature checked, so a flood costs one
  // counter per request rather than a read and an HMAC. Lenient: Stripe
  // retries a 429 like any other refusal (limits.ts).
  const wait = await overLimit(c, `stripe-webhook:${clientAddress(c)}`, LIMITS.stripeWebhook);
  if (wait !== null) return limitedJson(c, LIMITS.stripeWebhook, wait);

  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (declared > MAX_EVENT_BYTES) return c.json({ error: "too_large", limit_bytes: MAX_EVENT_BYTES }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_EVENT_BYTES) return c.json({ error: "too_large", limit_bytes: MAX_EVENT_BYTES }, 413);

  let event: Stripe.Event;
  try {
    event = await verify(c.env, raw, signature);
  } catch (err) {
    // Never say which part failed. A bad signature and a stale timestamp are
    // the same answer to anybody who is not Stripe.
    log(`stripe: refused a delivery, ${(err as Error).message}`);
    return c.json({ error: "bad_signature" }, 400);
  }

  // The claim IS the insert, so two deliveries arriving together cannot both
  // find nothing and both grant a month.
  const first = await db.claimStripeEvent(c.env.DB, event.id, event.type);
  if (!first) {
    log(`stripe: ${event.type} ${event.id} was already handled`);
    return c.json({ ok: true, duplicate: true });
  }

  try {
    const accountId = await handle(c, event);
    if (accountId) await db.attributeStripeEvent(c.env.DB, event.id, accountId);
    return c.json({ ok: true });
  } catch (err) {
    // Hold no claim on an event we did not finish: Stripe's retry has to be
    // able to do the work, not be told it was already done.
    await db.releaseStripeEvent(c.env.DB, event.id);
    const why = (err as Error).message;
    if (err instanceof RetryLater) {
      log(`stripe: ${event.type} ${event.id} deferred, ${why}`);
      return c.json({ error: "retry_later" }, 500);
    }
    log(`stripe: ${event.type} ${event.id} failed, ${why}`);
    return c.json({ error: "handler_failed" }, 500);
  }
});

/**
 * A Stripe client that works inside workerd.
 *
 * The SDK reaches for Node's HTTP client by default, which does not exist
 * here, so it is given the fetch one. Every caller in this service goes
 * through this rather than constructing its own, so there is one place where
 * that is true.
 */
export function stripeClient(env: Pick<Bindings, "STRIPE_SECRET_KEY">): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY ?? "sk_unset", { httpClient: Stripe.createFetchHttpClient() });
}

/**
 * Stripe's own verifier, told how to work inside workerd.
 *
 * The synchronous `constructEvent` throws here, so the async one is used with
 * the SubtleCrypto provider. No request is made: verification is an HMAC over
 * the raw body, and the API key is never spent.
 */
async function verify(env: Bindings, raw: string, signature: string): Promise<Stripe.Event> {
  const stripe = stripeClient(env);
  return stripe.webhooks.constructEventAsync(
    raw,
    signature,
    env.STRIPE_WEBHOOK_SECRET!,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

/** Deal with one verified event. Returns the account it was about, or "". */
async function handle(c: Context<AppEnv>, event: Stripe.Event): Promise<string> {
  if (!HANDLED.has(event.type)) {
    log(`stripe: ignoring ${event.type}`);
    return "";
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const accountId = idOf(session.client_reference_id) || idOf(session.metadata?.account_id);
    const customerId = idOf(session.customer);
    if (!accountId || !customerId) {
      throw new RetryLater(`a checkout session named ${accountId ? "no customer" : "no account"}`);
    }
    if (!(await db.accountById(c.env.DB, accountId))) {
      // Not retryable: a session naming an account that does not exist will
      // not start existing. Accounts are made at sign-in, before Checkout, so
      // this one was deleted while its Checkout was open. A subscription it
      // started would charge a card for nothing, so it is ended here; a throw
      // from that is retried like any other failure.
      log(`stripe: checkout session named account ${accountId}, which does not exist`);
      // A Checkout page left open in another tab can still be paid after its
      // account is deleted. A top-up has no events of its own, so the money
      // goes back here, once per session however often this is delivered. A
      // subscription is ended here and by its own events below, whichever
      // lands first.
      if (session.mode === "payment" && session.payment_status === "paid") {
        const intent = idOf(session.payment_intent as string | { id?: string } | null);
        if (intent) {
          await stripeClient(c.env).refunds.create({ payment_intent: intent }, { idempotencyKey: `orphan-topup:${session.id}` });
          log(`stripe: refunded top-up ${session.id}, paid after its account was deleted`);
        }
      }
      const subscriptionId = session.mode === "subscription" ? idOf(session.subscription) : "";
      if (subscriptionId) await endOrphan(c.env, subscriptionId, customerId);
      return "";
    }
    await db.linkStripeCustomer(c.env.DB, customerId, accountId);

    // A one-time payment is a top-up. It has no subscription behind it, so
    // this event is the only place the hours can be granted, and the session
    // id is what stops a redelivery granting them twice.
    if (session.mode === "payment") {
      if (session.payment_status !== "paid") {
        log(`stripe: top-up session ${session.id} is ${session.payment_status}; granting nothing`);
        return accountId;
      }
      const granted = await db.recordTopup(
        c.env.DB,
        session.id,
        accountId,
        TOPUP.audio_seconds,
        TOPUP.summary_tokens,
      );
      log(`stripe: top-up for ${accountId} ${granted ? "granted" : "was already granted"}`);
      return accountId;
    }

    // A subscription's own events carry the price, the status and the period,
    // so the allowance is written from those rather than from here.
    return accountId;
  }

  const sub = event.data.object as Stripe.Subscription;
  const accountId = await accountFor(c, sub);
  if (!accountId) {
    // Checkout stamped an account that is no longer here: it was deleted.
    // Usually deleting it is what canceled this subscription, and this is the
    // `deleted` event that follows. But a Checkout finished after the
    // deletion starts a subscription nobody can cancel, so anything still live
    // is ended. Nothing is left to mirror it onto either way, so Stripe is
    // told to stop rather than retrying for three days.
    log(`stripe: ${event.type} for ${sub.id} names a deleted account; nothing to update`);
    if (isLive(sub.status)) await endOrphan(c.env, sub.id, idOf(sub.customer));
    return "";
  }
  await db.putSubscription(c.env.DB, rowFor(c.env, sub, accountId));
  await writeAllowance(c, accountId);
  return accountId;
}

/**
 * Whose subscription this is.
 *
 * In order: what Checkout stamped on the subscription, the link learned at
 * checkout, and any subscription this customer already has here. A stamp
 * naming an account that no longer exists answers "", meaning deleted. A
 * subscription event that beats its own checkout session answers none of the
 * three, which is ordinary rather than exceptional, so it is deferred: Stripe
 * retries with backoff for about three days and the session lands long
 * before that. Accepting it instead would mean an event Stripe never sends
 * again and a subscriber who silently never got what they paid for.
 */
async function accountFor(c: Context<AppEnv>, sub: Stripe.Subscription): Promise<string> {
  const stamped = idOf(sub.metadata?.account_id);
  if (stamped) {
    // Accounts are made at sign-in, before anybody can reach Checkout, so a
    // stamp naming no account is one that was deleted since. "" says so.
    return (await db.accountById(c.env.DB, stamped)) ? stamped : "";
  }

  const customerId = idOf(sub.customer);
  if (customerId) {
    const linked = await db.accountIdForLinkedCustomer(c.env.DB, customerId);
    if (linked) return linked;
    const known = await db.accountIdForCustomer(c.env.DB, customerId);
    if (known) return known;
  }
  throw new RetryLater(`no account is known for customer ${customerId || "(none)"}`);
}

/** What Stripe just said about a subscription, as a row of migrations/0010. */
function rowFor(
  env: Bindings,
  sub: Stripe.Subscription,
  accountId: string,
): Omit<db.Subscription, "created_at" | "updated_at"> {
  const item = sub.items?.data?.[0];
  const priceId = idOf(item?.price?.id);
  return {
    stripe_subscription_id: sub.id,
    account_id: accountId,
    stripe_customer_id: idOf(sub.customer),
    price_id: priceId,
    // Resolved now and stored, so a price retired in Stripe next year does
    // not make this year's rows unreadable.
    tier: tierForPrice(env, priceId) ?? "",
    status: sub.status,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
  };
}

/**
 * When the paid-up period ends, as an ISO 8601 string.
 *
 * Stripe moved `current_period_end` off the subscription and onto each of its
 * items, so the item is where a current API version puts it. The top-level
 * field is read as well because the account's API version is a dashboard
 * setting that nobody here controls, and an older one still sends it. A
 * subscription with neither is stored with '' and entitles on its status
 * alone, which is what tiers.ts does with an empty period end.
 */
function periodEnd(sub: Stripe.Subscription): string {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  const seconds = item?.current_period_end ?? legacy;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

/**
 * Recompute what an account may spend, from every subscription it holds.
 *
 * Computed from the rows rather than from the event, because an account can
 * hold more than one subscription and the event only ever describes one of
 * them: somebody who upgrades mid-month has a canceled Starter beside a live
 * Pro, and the Starter's own `deleted` event must not be what decides.
 */
async function writeAllowance(c: Context<AppEnv>, accountId: string): Promise<void> {
  const existing = await db.allowance(c.env.DB, accountId);
  if (existing && PROTECTED_SOURCES.has(existing.source)) {
    log(`stripe: leaving the ${existing.source} allowance on account ${accountId} alone`);
    return;
  }
  const subs = await db.subscriptionsOf(c.env.DB, accountId);
  const best = entitlingSubscription(subs);
  // Nothing to derive from. An account with no rows at all has never
  // subscribed, and a missing allowance is what the proxy reads as the trial.
  if (!best) return;
  const grant = allowanceFromSubscription(best);
  await db.putAllowance(c.env.DB, accountId, grant);
  log(`stripe: account ${accountId} is now on ${grant.source}`);
}

/** A Stripe field that is a string, an expanded object, or absent. */
function idOf(value: string | { id?: string } | null | undefined): string {
  if (typeof value === "string") return value;
  return value?.id ?? "";
}

// --- Leaving: cancel, refund what is unused, forget the card -----------------

/**
 * Subscription statuses that can still charge somebody, or turn into one that
 * can. `canceled` and `incomplete_expired` are the two Stripe calls final.
 */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

/** Whether a subscription in this status could still charge somebody. */
export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

/** Stripe saying the thing does not exist, which for anything being ended means it already is. */
export function missing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeError && err.code === "resource_missing";
}

/** What ending one subscription came to. */
export type Ended = {
  canceled: boolean;
  /** Refunded to the card, in the smallest currency unit. */
  refunded: number;
  /** The refund was owed and did not go through; it is in the log to do by hand. */
  refundFailed: boolean;
};

/**
 * Cancel a subscription now, and refund the part of the period nobody will use.
 *
 * Canceled without Stripe's own proration on purpose: `prorate` puts the
 * unused time on the customer's credit balance, which is money nobody can
 * spend once the account is gone and has to be refunded and zeroed by hand
 * afterwards. Working out the unused share here and refunding the charge
 * sends it straight back to the card it came from.
 *
 * A cancel that fails throws, because the one outcome worse than a failed
 * deletion is a card that keeps being charged. A refund that fails does not:
 * the subscription is already canceled, so nobody is being charged, and the
 * refund is logged with Stripe's ids (the account row is about to be gone) so
 * it can be issued from the dashboard. A subscription Stripe does not have is
 * already canceled and owed nothing.
 */
export async function endSubscription(stripe: Stripe, id: string, now = Date.now()): Promise<Ended> {
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.cancel(id, { expand: ["latest_invoice"] });
  } catch (err) {
    if (missing(err)) return { canceled: false, refunded: 0, refundFailed: false };
    throw err;
  }
  try {
    return { canceled: true, refunded: await refundUnused(stripe, sub, now), refundFailed: false };
  } catch (err) {
    const invoice = idOf(sub.latest_invoice);
    logError(
      `stripe: REFUND OWED, issue it by hand. Subscription ${sub.id} (customer ${idOf(sub.customer)}, invoice ${invoice || "none"}) ` +
        `was canceled but its unused time was not refunded: ${(err as Error).message}`,
    );
    return { canceled: true, refunded: 0, refundFailed: true };
  }
}

/**
 * Refund the unused share of what the subscription's latest invoice took.
 *
 * The share is the time left in the period the invoice paid for, over the
 * whole of that period, read off the invoice's own lines. That is right for
 * an ordinary monthly invoice and for the proration invoice an upgrade makes,
 * whose lines start at the upgrade. A trial or a 100% off code paid nothing,
 * and gets nothing back. Rounded down to the cent, and never more than the
 * payment it is refunded against.
 *
 * The sales tax goes back with it, and has to: `amount_paid` is the total
 * including tax, so the refund carries the same share of the tax as of the
 * price. Stripe Tax records a refund of an invoice's charge as a reversal,
 * so the tax reports show it as refunded without a separate credit note.
 *
 * The idempotency key is the subscription, so a retried deletion or a second
 * webhook for the same orphan can never refund one subscription twice.
 */
async function refundUnused(stripe: Stripe, sub: Stripe.Subscription, now: number): Promise<number> {
  const invoice = typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  if (!invoice?.id || invoice.status !== "paid" || invoice.amount_paid <= 0) return 0;

  const periods = (invoice.lines?.data ?? []).map((line) => line.period).filter((p) => p && p.end > p.start);
  if (!periods.length) throw new Error(`invoice ${invoice.id} has no period to prorate over`);
  const start = Math.min(...periods.map((p) => p.start));
  const end = Math.max(...periods.map((p) => p.end));
  const seconds = now / 1000;
  if (seconds >= end) return 0;
  const unused = Math.min(1, (end - Math.max(seconds, start)) / (end - start));
  let amount = Math.floor(invoice.amount_paid * unused);
  if (amount <= 0) return 0;

  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: "paid", limit: 10 });
  const payment = payments.data.find((p) => p.payment.payment_intent || p.payment.charge);
  if (!payment) throw new Error(`invoice ${invoice.id} is paid, but not by a card this can refund`);
  if (payment.amount_paid) amount = Math.min(amount, payment.amount_paid);
  const target = payment.payment.payment_intent
    ? { payment_intent: idOf(payment.payment.payment_intent) }
    : { charge: idOf(payment.payment.charge) };

  await stripe.refunds.create(
    {
      ...target,
      amount,
      reason: "requested_by_customer",
      metadata: { subscription: sub.id, invoice: invoice.id, why: "account deleted, unused time" },
    },
    { idempotencyKey: `unused-time:${sub.id}` },
  );
  log(`stripe: refunded ${amount} of ${invoice.amount_paid} ${invoice.currency} on ${sub.id}, the unused time`);
  return amount;
}

/**
 * Delete a Stripe customer, which removes the saved card and the contact
 * details. Stripe keeps the invoices and payments themselves for its own
 * records. Returns false for a customer Stripe does not have, which is the
 * outcome wanted anyway; throws on anything else.
 */
export async function deleteCustomer(stripe: Stripe, id: string): Promise<boolean> {
  try {
    await stripe.customers.del(id);
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}

/**
 * End a subscription whose account was deleted before the subscription arrived.
 *
 * The race: somebody opens Checkout, deletes their account in another tab,
 * then pays. Deletion found nothing to cancel, and the Checkout that finishes
 * afterwards starts a subscription with a card on it and nobody left to
 * cancel it from. It is canceled and refunded exactly as a deletion would,
 * and the customer is deleted unless an account here still uses it.
 *
 * Asked of Stripe first, not taken from the event: the event can be a late
 * `created` for a subscription that is long canceled. A cancel that fails
 * throws, so Stripe's retry comes back and tries again; the refund and the
 * customer are logged rather than retried, because by then nobody is being
 * charged.
 */
async function endOrphan(env: Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">, subscriptionId: string, customerId: string): Promise<void> {
  const stripe = stripeClient(env);
  let current: Stripe.Subscription;
  try {
    current = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  // Already over: the deletion canceled it, and deleted the customer with it.
  if (!isLive(current.status)) return;
  const ended = await endSubscription(stripe, subscriptionId);
  log(
    `stripe: canceled ${subscriptionId}, which started after its account was deleted` +
      (ended.refunded ? `; refunded ${ended.refunded}` : ""),
  );

  const customer = customerId || idOf(current.customer);
  if (!customer) return;
  const inUse =
    (await db.accountIdForLinkedCustomer(env.DB, customer)) || (await db.accountIdForCustomer(env.DB, customer));
  if (inUse) return;
  try {
    await deleteCustomer(stripe, customer);
  } catch (err) {
    logError(`stripe: customer ${customer} of a deleted account was not deleted; delete it by hand: ${(err as Error).message}`);
  }
}

/**
 * End a Stripe trial once the 5 hours it stands for are spent.
 *
 * The trial this product sells is an amount of audio, and Stripe can only
 * count days, so the two are reconciled here: the subscription is created
 * with a long trial (src/billing.ts) and cut short the moment the hours run
 * out. Stripe then charges the card that was collected at checkout and sends
 * `customer.subscription.updated`, which is what writes the real allowance.
 * Nothing is granted from inside this function.
 *
 * Called from the proxy after a transcription settles, inside waitUntil, so a
 * paid call never waits on Stripe's API. Every early exit below is the normal
 * case: almost nobody who finishes a lecture is on the last of a trial.
 */
export async function endTrialIfSpent(
  // Narrowed to what it reads, so it is obvious this touches the database and
  // one key and nothing else on the environment.
  env: Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">,
  accountId: string,
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  const allowance = await db.allowance(env.DB, accountId);
  // An account with no row has never been through checkout, so there is no
  // trial to end and no card to charge. That is the free trial, not this one.
  if (allowance?.source !== "trial") return;

  const used = await db.usedThisPeriod(env.DB, accountId, "transcribe");
  if (used < TRIAL_ALLOWANCE.audio_seconds) return;

  const trialing = (await db.subscriptionsOf(env.DB, accountId)).find((s) => s.status === "trialing");
  if (!trialing) return;

  // Stripe takes a second or two to answer with the updated subscription, and
  // a panel uploading a lecture in chunks can arrive here several times
  // inside that window. One attempt per account per window is enough to end a
  // trial, and it means a webhook that never comes costs one call rather than
  // one per chunk forever.
  const gate = await db.hitRateLimit(env.DB, `trial-end:${accountId}`, 1, 300);
  if (!gate.allowed) return;

  try {
    await stripeClient(env).subscriptions.update(trialing.stripe_subscription_id, { trial_end: "now" });
    log(`stripe: trial spent, ended ${trialing.stripe_subscription_id} for ${accountId}`);
  } catch (err) {
    // Worth a line and nothing more. The trial ends on its own at the end of
    // its period, and until then the account is simply out of hours and can
    // top up, which is the same hard stop everybody else gets.
    log(`stripe: could not end the trial for ${accountId}, ${(err as Error).message}`);
  }
}
