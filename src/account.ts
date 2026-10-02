/**
 * Deleting an account, by the person it belongs to.
 *
 *   GET  /account/delete   (session) what is removed, and a box to type your email in
 *   POST /account/delete   (session signed in within REAUTH_MINUTES, same
 *                           origin, email typed) does it
 *
 * A browser route only. A panel's device token lives on a laptop for months,
 * and a copy of one must never be enough to erase the account it belongs to.
 *
 * The order, and what happens when a step fails:
 *
 * 1. Stripe. Every subscription that could still charge is canceled now, the
 *    unused part of the period is refunded to the card, and every Stripe
 *    customer is deleted, which removes the saved card (leaveStripe in
 *    billing.ts). If Stripe cannot be reached or refuses a cancel, NOTHING is
 *    deleted and the page says so: the one outcome worse than a deletion that
 *    did not happen is an account that is gone while its card is still being
 *    charged, with nothing left here to cancel from. A refund or a customer
 *    deletion that fails is logged to finish by hand and does not stop it,
 *    because by then nobody is being charged.
 * 2. The database. Every row with the account in it goes in one D1 batch,
 *    and a keyed hash of the Google sub goes into trial_used in the same one,
 *    which is one transaction (deleteAccountData in db.ts), so the account is
 *    never left half deleted. Device tokens are rows in it, so every Mac is
 *    signed out in the same instant. If the batch fails, the page says the
 *    plan is canceled and nothing else changed, and trying again is safe:
 *    Stripe has nothing live left to cancel.
 * 3. Google Drive. The grant read before step 2 is revoked at Google, best
 *    effort, exactly as Disconnect does it. After the rows rather than
 *    before, so a failed batch leaves Drive working as the page says. A
 *    Google failure is logged and changes nothing: the stored token is
 *    already deleted, so this service can never use it again.
 * 4. The relay. Each device's object drops its panel socket and forgets the
 *    Mac's name. Best effort: a socket left open reaches nothing, because
 *    /p/<device>/ looks the device up in the database and it is gone.
 * 5. The session cookie is cleared, and the page says the account is deleted.
 *
 * Posting again with a cookie from before is harmless: the session no longer
 * names an account, so it is treated as signed out.
 */

import { Hono, type Context } from "hono";
import { leaveStripe, type StripeExit } from "./billing";
import { trialHash, trialSecret } from "./crypto";
import * as db from "./db";
import { revokeGrantAtGoogle } from "./drive";
import type { Account, AppEnv, Bindings } from "./env";
import { LIMITS, limitedPage, overLimit } from "./limits";
import { accountDeletedPage, deleteAccountPage, reauthToDeletePage, type DeletionSummary } from "./pages";
import { log } from "./log";
import { forgetRelay } from "./relay";
import { browserOnly, clearSession, sameOrigin, sessionSignedInAt } from "./session";
import { isLive } from "./stripe";
import { TRIAL_USED_ALLOWANCE } from "./tiers";

/**
 * At sign-in: a Google identity whose earlier account was deleted gets no
 * second trial. Called on every sign-in, which is one indexed read; writes
 * only when the identity is in trial_used and the account has no allowance
 * row yet, so a paid plan is never touched. See migrations/0013.
 */
export async function applyTrialBlock(env: Pick<Bindings, "DB" | "SESSION_SECRET" | "TRIAL_SECRET">, accountId: string, sub: string): Promise<void> {
  if (!(await db.trialWasUsed(env.DB, await trialHash(trialSecret(env), sub)))) return;
  await db.blockTrial(env.DB, accountId, TRIAL_USED_ALLOWANCE);
}

export const account = new Hono<AppEnv>();

/**
 * How recent a Google sign-in has to be to delete with.
 *
 * Why a fresh sign-in at all: a Mac's panel is relayed at /p/<device>/ on
 * THIS origin, with its own inline scripts (relay.ts). So a script in a
 * panel page is same-origin with the account: it can read this page, see the
 * email, and post the form with a correct Origin. Typing the email proves
 * nothing to such a script, and a copy of a device token is enough to be the
 * panel. A sign-in within the last few minutes is something only a person
 * clicking through Google's account chooser can produce.
 */
export const REAUTH_MINUTES = 10;

async function signedInRecently(c: Context<AppEnv>): Promise<boolean> {
  const at = await sessionSignedInAt(c);
  return at > 0 && Date.now() - at <= REAUTH_MINUTES * 60 * 1000;
}

async function summaryFor(c: Context<AppEnv>, who: Account): Promise<DeletionSummary> {
  const [devices, grant, subs] = await Promise.all([
    db.devicesOf(c.env.DB, who.id),
    db.driveGrant(c.env.DB, who.id),
    db.subscriptionsOf(c.env.DB, who.id),
  ]);
  return {
    macs: devices.length,
    drive: Boolean(grant && !grant.revoked_at),
    plan: subs.some((s) => isLive(s.status)),
  };
}

account.get("/account/delete", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const who = c.get("account");
  if (!who) return c.redirect("/login?next=" + encodeURIComponent("/account/delete"));
  if (!(await signedInRecently(c))) return c.html(reauthToDeletePage(who, REAUTH_MINUTES));
  return c.html(deleteAccountPage(who, await summaryFor(c, who), ""));
});

account.post("/account/delete", async (c) => {
  const refusal = browserOnly(c);
  if (refusal) return refusal;
  const who = c.get("account");
  if (!who) return c.redirect("/login?next=" + encodeURIComponent("/account/delete"));
  if (!sameOrigin(c)) return c.text("This form must be submitted from " + c.env.PUBLIC_URL, 403);
  if (!(await signedInRecently(c))) return c.html(reauthToDeletePage(who, REAUTH_MINUTES), 403);
  const wait = await overLimit(c, `account-delete:${who.id}`, LIMITS.accountDelete);
  if (wait !== null) return limitedPage(c, wait);

  const form = await c.req.parseBody();
  const typed = String(form.confirm_email ?? "").trim().toLowerCase();
  if (!typed || typed !== who.email.toLowerCase()) {
    const error = typed
      ? "That does not match the email on this account, so nothing was deleted."
      : "Type your email address to confirm. Nothing was deleted.";
    return c.html(deleteAccountPage(who, await summaryFor(c, who), error), 400);
  }

  // 1. Stripe, and stop here if a cancel fails.
  let stripe: StripeExit;
  try {
    stripe = await leaveStripe(c.env, who.id);
    if (stripe.canceled) {
      log(`account ${who.id}: canceled ${stripe.canceled} subscription(s) and refunded ${stripe.refunded} before deleting`);
    }
  } catch (err) {
    log(`account ${who.id}: deletion stopped, Stripe could not cancel: ${(err as Error).message}`);
    return c.html(
      deleteAccountPage(
        who,
        await summaryFor(c, who),
        "We could not cancel your plan with Stripe, so nothing was deleted. Try again in a few minutes. If it keeps happening, cancel the plan under Manage billing on your account page, then come back here.",
      ),
      502,
    );
  }

  // Read before the rows go: every relay object to clear afterwards, and the
  // Drive grant to revoke once the rows are gone.
  const [deviceIds, driveGrant] = await Promise.all([
    db.allDeviceIdsOf(c.env.DB, who.id),
    db.driveGrant(c.env.DB, who.id),
  ]);

  // 2. Every row, in one transaction.
  try {
    await db.deleteAccountData(c.env.DB, who.id, await trialHash(trialSecret(c.env), who.google_sub));
  } catch (err) {
    log(`account ${who.id}: deleting the rows failed: ${(err as Error).message}`);
    return c.html(
      deleteAccountPage(
        who,
        await summaryFor(c, who).catch(() => ({ macs: 0, drive: false, plan: false })),
        "Your plan is canceled, but the rest of your account could not be deleted just now. Nothing else changed. Please try again.",
      ),
      500,
    );
  }

  // 3. Google Drive, best effort. After the rows, so a batch that failed
  // above really did leave "nothing else changed", Drive included.
  await revokeGrantAtGoogle(c.env, driveGrant);

  // 4. The relay, best effort.
  await Promise.all(
    deviceIds.map((id) =>
      forgetRelay(c.env, id).catch((err) => log(`account ${who.id}: relay for ${id} not cleared: ${(err as Error).message}`)),
    ),
  );

  // 5. Signed out, and told.
  clearSession(c);
  log(`account ${who.id} deleted by its owner (${deviceIds.length} device(s))`);
  return c.html(accountDeletedPage(who.email, stripe));
});
