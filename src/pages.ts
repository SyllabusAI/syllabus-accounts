/** The few pages this Worker shows a person. Plain HTML, one stylesheet. */

import type { BillingView } from "./billing";
import type { DriveGrant } from "./db";
import type { Account, Device } from "./env";
import { SELLABLE, TIERS, TOPUP, TRIAL_ALLOWANCE, type TierName } from "./tiers";
import { escapeHtml as h, panelUrl } from "./util";

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34em; margin: 4em auto; padding: 0 1.5em; }
  h1 { font-size: 1.4em; margin-bottom: 0.2em; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  code, input.code { font: 1.3em/1 ui-monospace, monospace; letter-spacing: 0.12em; }
  input, button { font: inherit; padding: 0.5em 0.8em; border-radius: 6px; border: 1px solid #8884; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; color: white; border-color: transparent; }
  form.row { display: flex; gap: 0.6em; flex-wrap: wrap; align-items: center; margin: 1em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  td, th { text-align: left; padding: 0.4em 0.6em 0.4em 0; border-bottom: 1px solid #8883; vertical-align: top; }
  .ok { color: #15803d; }
  .warn { color: #b45309; }
  button.danger { background: #b91c1c; color: white; border-color: transparent; }
  section.danger { margin-top: 3em; padding-top: 1em; border-top: 1px solid #8884; }
  label { display: block; margin: 1em 0 0.3em; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Syllabus</title><style>${STYLE}</style></head>
<body><h1>${h(title)}</h1>${body}</body></html>`;
}

const FOOTER = `<p class="muted" style="margin-top:3em"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="https://github.com/SyllabusAI/LectureAI">Syllabus on GitHub</a></p>`;

export function landing(): string {
  return page(
    "Syllabus accounts",
    `<p class="muted">Syllabus records your lectures on your Mac and files study notes in your Google Drive.
        Sign in to connect a Mac running Syllabus to your account.</p>
     <p><a href="/login"><button class="primary">Sign in with Google</button></a></p>${FOOTER}`,
  );
}

/** Where a person writes to us about their account, their data, or these pages. */
const CONTACT = `<a href="mailto:syllabus@maincoursemedia.com">syllabus@maincoursemedia.com</a>`;

export function privacyPage(): string {
  return page(
    "Privacy",
    `<p class="muted">Last updated September 29, 2026.</p>
     <p>Syllabus records your lectures on your Mac and turns them into transcripts and study notes in your own Google
        Drive. It is made by Main Course Media LLC, a Texas company ("we"). This page says what reaches us, what we keep,
        who else handles it, and how to get rid of it.</p>
     <h2>What we keep</h2>
     <ul>
       <li><strong>Who you are.</strong> When you sign in with Google we keep your Google account id, email address, and
           display name.</li>
       <li><strong>Your Macs.</strong> The name of each Mac you connect, when it connected, when it last checked in, and
           its panel's address. Each Mac holds a token that identifies it; we keep only a hash of that token.</li>
       <li><strong>Your settings.</strong> The text of your class schedule, so it can follow you to another Mac.</li>
       <li><strong>Your Google Drive connection.</strong> If you connect Drive, the refresh token Google issues is stored
           encrypted and is used only to mint short-lived access tokens for your own Macs. The Macs never receive the
           refresh token. Syllabus asks only for the <code>drive.file</code> permission, which reaches files Syllabus
           itself created and nothing else in your Drive.</li>
       <li><strong>Your plan and usage.</strong> Which plan you are on, its renewal date, and how much you have used this
           month: hours of audio, the size of each summary, and how many study sessions you opened, with what each one
           cost us. These are numbers. They do not include what was said or asked.</li>
       <li><strong>Service logs.</strong> Our hosting keeps short-lived logs of requests and errors. They name an account
           by its id, not by its name or email.</li>
     </ul>
     <h2>What passes through us and is not kept</h2>
     <p>On a paid plan or the trial, Syllabus uses our accounts with the AI providers instead of keys of your own. So these
        pass through this service on their way to a provider and back:</p>
     <ul>
       <li><strong>Lecture audio</strong>, in short pieces, sent for transcription.</li>
       <li><strong>Transcripts</strong>, sent to be summarized.</li>
       <li><strong>Summaries, transcripts, and your questions</strong>, when you use the study assistant.</li>
       <li><strong>Your Mac's panel pages</strong>, when you open that panel from a browser at its web address.</li>
     </ul>
     <p>None of this is written to our database or our logs. It is handed on, the answer is handed back to your Mac, and
        what stays here is the usage count above. Your recordings, transcripts, and notes are stored on your Mac and in
        your Google Drive, not with us.</p>
     <h2>Who else handles it</h2>
     <table><tbody>
       <tr><td><strong>Groq</strong></td><td>Transcribes lecture audio.</td></tr>
       <tr><td><strong>OpenAI</strong></td><td>Transcribes lecture audio when Groq is unavailable.</td></tr>
       <tr><td><strong>Anthropic</strong></td><td>Writes summaries and runs the study assistant.</td></tr>
       <tr><td><strong>Stripe</strong></td><td>Takes payments and holds your card and billing details. We never see your
           full card number.</td></tr>
       <tr><td><strong>Google</strong></td><td>Signs you in, and stores your notes in your Drive if you connect it.</td></tr>
       <tr><td><strong>Cloudflare</strong></td><td>Hosts this service and its database.</td></tr>
     </tbody></table>
     <p>We use each provider's paid business service, whose terms do not allow it to train its models on what we send.
        We do not train any model on your recordings, transcripts, notes, or questions, and we do not let anyone else do
        so.</p>
     <p>If you use Syllabus with API keys of your own, your Mac talks to those providers directly and none of the above
        passes through us.</p>
     <h2>How it is used</h2>
     <p>Only to run Syllabus for you: signing you in, telling your Macs who they belong to, syncing your settings, letting
        your Macs file notes to your Drive, transcribing and summarizing your lectures, billing your plan, and keeping the
        service working and secure. Nothing is sold, shared with advertisers, or used to build profiles. Syllabus's use
        and transfer of information received from Google APIs adheres to the
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data
        Policy</a>, including the Limited Use requirements.</p>
     <h2>Where it lives</h2>
     <p>On Cloudflare, in a database that belongs to this service. Traffic to and from it is
        encrypted.</p>
     <h2>Your choices</h2>
     <ul>
       <li>Remove a Mac from your account page at any time; its token stops working at once.</li>
       <li>Disconnect Google Drive from your account page; the grant is revoked at Google for every Mac at once.
           You can also remove Syllabus under your Google account's third-party access settings.</li>
       <li>Delete your account and everything stored with it from your account page, under Delete your account. Any
           plan is canceled and the unused part of it refunded, every Mac is signed out, your Drive connection is
           revoked, and the rest is erased. Your saved card and billing details are removed from Stripe, which keeps
           only its own record of past payments. After a deletion we keep one thing: a one-way scrambled identifier
           made from your Google sign-in, used only to stop the free trial being given out twice. It cannot be turned
           back into your name or email, and nothing else is kept with it.</li>
       <li>Ask us what we hold about you, or to correct it, by writing to ${CONTACT}.</li>
     </ul>
     <h2>Age</h2>
     <p>Syllabus is for people 18 and older. We do not knowingly keep an account for anyone younger, and we delete one when
        we learn of it.</p>
     <h2>Changes</h2>
     <p>When this page changes in a way that matters, we update the date at the top and email account holders before the
        change takes effect.</p>
     <h2>Contact</h2>
     <p>Main Course Media LLC, Texas. ${CONTACT}</p>
     <p>This service is open source; its code is at
        <a href="https://github.com/SyllabusAI/syllabus-accounts">github.com/SyllabusAI/syllabus-accounts</a>.</p>
     ${FOOTER}`,
  );
}

export function termsPage(): string {
  const plans = SELLABLE.map((t) => {
    const tier = TIERS[t.tier as TierName];
    return `<li>${h(t.label)} · $${tier.price_usd} a month for ${tier.audio_hours} hours of lecture audio${
      tier.assistant_sessions ? `, plus ${tier.assistant_sessions} study assistant sessions` : ""
    }</li>`;
  }).join("");
  return page(
    "Terms",
    `<p class="muted">Last updated September 29, 2026.</p>
     <p>These terms are an agreement between you and Main Course Media LLC, a Texas limited liability company ("we"),
        for Syllabus, its Mac app, and this account service. By creating an account or using Syllabus you accept them.
        If you do not accept them, do not use Syllabus.</p>
     <h2>Who can use it</h2>
     <p>You must be 18 or older and able to enter a binding agreement. One account is for one person.</p>
     <h2>Your recordings are your responsibility</h2>
     <p>Syllabus is for recording and studying lectures you attend. You may record only where you are allowed to. That
        means following your school's rules, your instructor's wishes, and every law that applies to recording where you
        are, including any that require everyone present to consent. Do not use Syllabus to record private
        conversations, or to copy, share, or sell course material you have no right to.</p>
     <p>You keep all rights to your recordings, transcripts, and notes. You give us only the permission needed to
        transcribe and summarize them for you, as the <a href="/privacy">privacy page</a> describes.</p>
     <p>You agree to defend and repay Main Course Media LLC for any claim, loss, or cost, including reasonable legal
        fees, that comes from what you record or how you use Syllabus in breach of these terms.</p>
     <h2>Plans, trial, and billing</h2>
     <ul>${plans}</ul>
     <ul>
       <li><strong>Trial.</strong> Every plan starts with ${TRIAL_ALLOWANCE.audio_seconds / 3600} hours of lecture audio to
           try it. We ask for a card at the start and do not charge it until those hours are used or the trial period
           ends, whichever comes first. One trial per person.</li>
       <li><strong>Automatic renewal.</strong> A plan renews every month and your card is charged the plan's price, plus
           any sales tax, until you cancel. We will tell you by email before a price goes up, and a new price starts
           only at your next renewal.</li>
       <li><strong>Hours.</strong> A plan's hours are for its month and do not carry over. When they run out, recording
           stops until the next month or until you add hours. You are never billed for going over.</li>
       <li><strong>Extra hours.</strong> You can buy ${TOPUP.audio_hours} more hours for $${TOPUP.price_usd} as a one-time
           payment. They are for the current month.</li>
       <li><strong>Canceling.</strong> Cancel at any time under Manage billing on your account page. You keep your
           plan's hours until the end of the month you have paid for, and you are not charged again. Canceling this way
           does not refund the current month.</li>
       <li><strong>Refunds.</strong> If you delete your account, we cancel your plan and refund the unused part of the
           current month to your card. If you believe you were charged in error, write to ${CONTACT} and we will make it
           right.</li>
       <li><strong>Codes.</strong> A promotion code from us is personal, may end, and has no cash value.</li>
     </ul>
     <h2>Acceptable use</h2>
     <p>Do not share your account, resell access, try to get around the limits on your plan, send anything to the
        service other than lectures and your own study questions, or interfere with the service or other people's use of
        it. We may suspend or close an account that does, and we will tell you why.</p>
     <h2>AI output</h2>
     <p>Transcripts, summaries, and study assistant answers are made by AI and can be wrong or incomplete. Check anything
        important against the lecture and your course materials. Follow your school's rules on using AI in coursework.</p>
     <h2>Changes to the service and these terms</h2>
     <p>Syllabus may change, and features may be added or removed. If we change these terms in a way that matters, we
        will email you before the change takes effect; using Syllabus after that means you accept the new terms. If we
        stop offering Syllabus, we will give you at least 30 days' notice and refund any month you have paid for and
        not received. Your recordings and notes stay on your Mac and in your Google Drive regardless.</p>
     <h2>No warranty</h2>
     <p>Syllabus is provided as it is and as available. To the extent the law allows, we make no warranty of any kind,
        including that it will be accurate, uninterrupted, or fit for a particular purpose.</p>
     <h2>Limits on liability</h2>
     <p>To the extent the law allows, Main Course Media LLC is not liable for any indirect, incidental, or consequential
        loss, lost data, or lost grades arising from Syllabus. Our total liability for any claim is limited to what you
        paid us in the 12 months before it arose.</p>
     <h2>Law</h2>
     <p>These terms are governed by the laws of the State of Texas, without regard to its conflict of law rules. Any
        dispute belongs in the state or federal courts located in Texas, and you and we both agree to their
        jurisdiction.</p>
     <h2>Contact</h2>
     <p>Main Course Media LLC, Texas. ${CONTACT}</p>
     ${FOOTER}`,
  );
}

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

/** What a Mac's relay object says about it, or null when it could not be asked. */
export type RelayInfo = { connected: boolean; connected_at: string; disconnected_at: string } | null;

function relayLine(d: Device, info: RelayInfo | undefined, publicUrl: string): string {
  const address = panelUrl(publicUrl, d.id);
  const link = `<a href="${h(address)}">${h(address.replace(/^https:\/\//, ""))}</a>`;
  if (!info) return `<br><span class="muted">Its panel: ${link}</span>`;
  if (info.connected) return `<br><span class="ok">Connected now</span> <span class="muted">at ${link}</span>`;
  const last = info.connected_at ? `, last connected ${when(info.connected_at)}` : ", has not connected yet";
  return `<br><span class="muted">Not connected${last}. Its panel: ${link}</span>`;
}

export function accountPage(
  account: Account,
  devices: Device[],
  grant: DriveGrant | null = null,
  relays: Record<string, RelayInfo> = {},
  publicUrl = "",
  billing: BillingView | null = null,
  notice = "",
): string {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr><td><strong>${h(d.name)}</strong><br><span class="muted">${h(d.profile)}, added ${when(d.created_at)}</span>${publicUrl ? relayLine(d, relays[d.id], publicUrl) : ""}</td>
                  <td class="muted" style="white-space:nowrap">last seen ${when(d.last_seen_at)}</td>
                  <td><form method="post" action="/devices/${h(d.id)}/revoke"><button>Remove</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No Macs yet. Open the Setup page in Syllabus and choose Sign in to a Syllabus account.</td></tr>`;
  return page(
    "Your Syllabus account",
    `${billingNotice(notice)}<p>Signed in as <strong>${h(account.email)}</strong>${account.name ? ` (${h(account.name)})` : ""}.
        <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></p>
     <h2>Your Macs</h2>
     <p class="muted">Each Mac's panel has an address here that only you can open, from any browser or phone, whenever that Mac is awake and its panel is running. A Mac that goes 90 days without using Syllabus is signed out and can sign in again from its Setup page.</p>
     <table><tbody>${rows}</tbody></table>
     ${devices.length ? signOutEverything : ""}
     <h2>Your plan</h2>
     ${billingSection(billing)}
     <h2>Google Drive</h2>
     ${driveSection(grant)}
     <h2>Connect a Mac</h2>
     <p class="muted">Syllabus shows a code on its Setup page. Enter it here.</p>
     ${codeForm("", "")}
     <section class="danger">
       <h2>Delete your account</h2>
       <p class="muted">This removes your Macs, your class schedule, your Google Drive connection, your plan, and your
          usage history from Syllabus, for good. Your recordings and notes stay on your Mac and in your Google Drive.</p>
       <p><a href="/account/delete"><button>Delete your account</button></a></p>
     </section>`,
  );
}

/** What deleting an account will do, said before it is done. */
export type DeletionSummary = { macs: number; drive: boolean; plan: boolean };

/** The confirmation step: what goes, what stays, and a box to type your email in. */
export function deleteAccountPage(account: Account, summary: DeletionSummary, error: string): string {
  const macs = summary.macs === 1 ? "Your Mac is" : summary.macs > 1 ? `All ${summary.macs} of your Macs are` : "";
  const items = [
    summary.plan
      ? "<li>Your plan is canceled right away and you are not charged again. The unused part of the current billing period is refunded to the card you paid with.</li>"
      : "",
    macs ? `<li>${macs} signed out and removed. Syllabus on a Mac asks you to sign in again the next time you open it.</li>` : "",
    summary.drive ? "<li>Your Google Drive connection is revoked. The notes already in your Drive stay there.</li>" : "",
    "<li>Your class schedule, your usage history, and your account details are deleted.</li>",
  ].join("");
  return page(
    "Delete your account",
    `${error ? `<p class="warn">${h(error)}</p>` : ""}
     <p>This permanently deletes the Syllabus account for <strong>${h(account.email)}</strong>. It cannot be undone.</p>
     <ul>${items}</ul>
     <p class="muted">Recordings and notes on your Mac and in your Google Drive are not touched. Your saved card and
        billing details are removed from Stripe, which keeps only its own record of past payments and invoices. We keep one scrambled identifier made from your Google sign-in, which
        cannot be turned back into your name or email, only so the free trial is not given out twice. Signing in again
        later with the same Google account starts a new, empty account without a free trial.</p>
     <form method="post" action="/account/delete">
       <label for="confirm_email">Type <strong>${h(account.email)}</strong> to confirm</label>
       <div class="row" style="display:flex;gap:0.6em;flex-wrap:wrap">
         <input id="confirm_email" name="confirm_email" type="email" autocomplete="off" autocapitalize="off" spellcheck="false" required>
         <button class="danger">Delete my account</button>
       </div>
     </form>
     <p class="muted"><a href="/">Keep my account</a></p>`,
  );
}

/** Before the confirmation step: a sign-in that is not recent enough to delete with. */
export function reauthToDeletePage(account: Account, minutes: number): string {
  return page(
    "Delete your account",
    `<p>To delete the Syllabus account for <strong>${h(account.email)}</strong>, sign in with Google again first.
        This makes sure it is really you, and not something else using this browser.</p>
     <p class="muted">You then have ${minutes} minutes to confirm the deletion.</p>
     <p><a href="/login?next=${encodeURIComponent("/account/delete")}"><button class="primary">Sign in again</button></a></p>
     <p class="muted"><a href="/">Keep my account</a></p>`,
  );
}

/** After the deletion: signed out, and nothing left here. */
export function accountDeletedPage(email: string, stripe: { refunded: number; refundFailed: boolean }): string {
  const refund = stripe.refundFailed
    ? `<p>Your plan is canceled. The refund for its unused days did not go through on its own, so we will send it to
        your card ourselves. You do not need to do anything.</p>`
    : stripe.refunded
      ? `<p>Your plan is canceled, and $${(stripe.refunded / 100).toFixed(2)} for its unused days is on its way back to
          your card. Refunds usually show up within 5 to 10 business days.</p>`
      : "";
  return page(
    "Your account is deleted",
    `<p>Everything Syllabus stored for <strong>${h(email)}</strong> is gone, and you are signed out.</p>
     ${refund}
     <p>Syllabus on your Macs will ask you to sign in again. Your recordings and notes are still on your Mac and in
        your Google Drive.</p>
     <p class="muted">You can also remove Syllabus from your Google account under
        <a href="https://myaccount.google.com/connections">third-party connections</a>.</p>
     <p class="muted"><a href="/">Syllabus accounts</a></p>`,
  );
}

/**
 * A word about the checkout the person has just come back from.
 *
 * Coming back is not the same as having paid. Stripe redirects the moment its
 * own page is done, and what an account may spend is written when the webhook
 * arrives, which is usually within a second but is a different event. So this
 * says what happened at Stripe and lets the plan below say what is true here,
 * rather than promising a plan this page has not read yet.
 */
function billingNotice(notice: string): string {
  if (notice === "done") {
    return `<p class="ok">Thanks. Stripe has your subscription. It can take a moment to show up below.</p>`;
  }
  if (notice === "canceled") return `<p class="muted">No change was made and nothing was charged.</p>`;
  if (notice === "topped-up") {
    return `<p class="ok">Thanks. Your extra hours land as soon as Stripe confirms the payment, usually within a moment.</p>`;
  }
  return "";
}

/**
 * What the person is paying for, and what is left of it.
 *
 * Every number here is read from the same `allowances` row the proxy
 * enforces, so the page cannot flatter the account. It does not decide
 * anything: a panel that is refused is refused by the proxy, not by what this
 * paragraph says.
 */
function billingSection(view: BillingView | null): string {
  if (!view) return `<p class="muted">Billing is not switched on yet.</p>`;

  const source = view.allowance?.source || "trial";
  // The SAME sum the proxy enforces: the plan's row plus anything bought on
  // top of it this month. Leaving the top-up out here once showed a capped
  // account hours it was in fact allowed to record, which is the one way this
  // section is allowed to be wrong and is not.
  const allowedSeconds = (view.allowance?.audio_seconds ?? TRIAL_ALLOWANCE.audio_seconds) + view.toppedUp;
  const left = Math.max(0, allowedSeconds - view.audioUsed);
  const usedLine = view.audioUsed <= 0
    ? `<p class="muted">Nothing recorded this month. All ${hours(allowedSeconds)} are yours.</p>`
    : left <= 0
      ? `<p class="warn">All ${hours(allowedSeconds)} are used. Recording is stopped until you add more or the month turns over, and nothing is being billed for going over.</p>`
      : `<p class="muted">${hours(view.audioUsed)} of ${hours(allowedSeconds)} used this month${view.toppedUp > 0 ? `, ${hours(view.toppedUp)} of it topped up` : ""}. ${hours(left)} left.</p>`;

  const sub = view.subscription;
  const manage = view.hasCustomer
    ? `<form method="post" action="/billing/portal" style="display:inline"><button>Manage billing</button></form>`
    : "";
  // Offered when the hours are gone, which is the only moment it is the right
  // answer. A cap is a hard stop, so this is the way past one, and it is one
  // click rather than a bill that arrives later.
  const topUp = view.canTopUp && left <= 0
    ? `<p><form method="post" action="/billing/topup" style="display:inline"><button class="primary">Add ${TOPUP.audio_hours} hours for $${TOPUP.price_usd}</button></form>
       <span class="muted">A one-time payment. These hours are for this month.</span></p>`
    : "";

  if (source === "lapsed" || (sub && sub.status === "canceled")) {
    return `<p class="warn">Your subscription has ended, so there are no hours on this account.</p>
      <p class="muted">Starting one again picks up where you left off. Your notes in Drive were never touched.</p>
      ${tierButtons()}${manage ? `<p>${manage}</p>` : ""}`;
  }

  if (sub && sub.status === "trialing") {
    const name = tierName(sub.tier);
    const plan = `$${priceOf(sub.tier)} a month for ${TIERS[sub.tier as TierName]?.audio_hours ?? 0} hours`;
    // Spending the trial is what ends it, and the proxy has already asked
    // Stripe to do so by the time anybody reads this. So the answer here is
    // the plan arriving, not a top-up: the plan is more hours for less money
    // than five bought one at a time.
    if (left <= 0) {
      return `<p>Your trial hours are used up, so <strong>${h(name)}</strong> is starting now.</p>
        <p class="muted">Stripe is charging the card you gave at checkout, ${plan}. This page shows the new hours as soon as that goes through.</p>
        <p>${manage}</p>`;
    }
    return `<p>You are trying <strong>${h(name)}</strong>, with <strong>${hours(allowedSeconds)}</strong> of lecture audio to see how it goes.</p>
      <p class="muted">Your card is not charged until those hours are used up, or ${onDate(sub.current_period_end) || "the trial runs out"}, whichever comes first. Then it is ${plan}.</p>
      ${usedLine}<p>${manage}</p>`;
  }

  if (sub) {
    const name = tierName(sub.tier);
    const ends = sub.current_period_end ? onDate(sub.current_period_end) : "";
    const renewal = !ends
      ? ""
      : sub.cancel_at_period_end
        ? `<p class="warn">Ends ${ends}. You keep these hours until then.</p>`
        : `<p class="muted">Renews ${ends}.</p>`;
    const state = sub.status === "past_due"
      ? `<p class="warn">Stripe could not charge your card and is trying again. Nothing has been cut off.</p>`
      : "";
    return `<p><strong>${h(name)}</strong>, $${priceOf(sub.tier)} a month.</p>${state}${renewal}${usedLine}${topUp}
      <p>${manage}</p>`;
  }

  if (source === "trial_used") {
    // A Google identity that deleted an earlier account after its trial
    // (migrations/0013). No second trial, and no Stripe trial at Checkout.
    return `<p>The free trial for this Google account was already used, on an account that was deleted, so there are no free hours here.</p>
      <p class="muted">Pick a plan to start recording. Your card is charged when you subscribe, and you can change or cancel it yourself at any time.</p>
      ${tierButtons()}${redeemForm()}`;
  }

  return `<p>You are on the free trial: <strong>${hours(allowedSeconds)}</strong> of lecture audio.</p>${usedLine}
    <p class="muted">Pick a plan to keep recording once the trial is used up. Every plan starts with 5 hours to try, your card is not charged until those are gone, and you can change or cancel it yourself at any time.</p>
    ${tierButtons()}${redeemForm()}`;
}

function tierName(tier: string): string {
  return tier ? tier[0].toUpperCase() + tier.slice(1) : "Your plan";
}

/**
 * The way in for somebody with a 100%-off code.
 *
 * Its own form because it is its own kind of session: no trial, and no card
 * asked for. Checkout cannot know in advance that a code will be typed into
 * it, so the person says so here instead.
 */
function redeemForm(): string {
  const options = SELLABLE.map((t) => `<option value="${h(t.tier)}">${h(t.label)}</option>`).join("");
  return `<p class="muted" style="margin-top:1.5em">Have a code from us?</p>
    <form method="post" action="/billing/checkout" class="row">
      <input type="hidden" name="redeem" value="1">
      <select name="tier">${options}</select>
      <button>Redeem a code</button>
    </form>`;
}

function tierButtons(): string {
  return SELLABLE.map(
    (t) => `<form method="post" action="/billing/checkout" class="row" style="margin:0.4em 0">
        <input type="hidden" name="tier" value="${h(t.tier)}">
        <button class="primary">Choose ${h(t.label)}</button>
        <span class="muted">${h(t.note)}</span>
      </form>`,
  ).join("");
}

function priceOf(tier: string): number {
  return TIERS[tier as TierName]?.price_usd ?? 0;
}

/**
 * Seconds as something a person says out loud.
 *
 * Rounded to one decimal below ten hours and to whole hours above, because
 * "36 hours left" is what somebody plans a week around and "36.4" is not.
 * Singulars are handled: a first lecture should not read "1 hours".
 */
function hours(seconds: number): string {
  if (seconds <= 0) return "none";
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${mins} ${mins === 1 ? "minute" : "minutes"}`;
  }
  const count = seconds / 3600;
  const shown = count >= 10 ? Math.round(count) : Math.round(count * 10) / 10;
  return `${shown} ${shown === 1 ? "hour" : "hours"}`;
}

/** A renewal date, said the way a date is said rather than logged. */
function onDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * For a Mac that was lost or a token that may have been copied: removing the
 * Macs one at a time is not enough if whoever holds the token can connect
 * more while you work, so this ends every connection in one go.
 */
const signOutEverything = `<p class="muted">Lost a Mac, or think someone else has a copy of its connection?
  <form method="post" action="/devices/revoke-all" style="display:inline"><button>Sign out every Mac</button></form>
  Each one asks for a new code the next time you open it.</p>`;

function driveSection(grant: DriveGrant | null): string {
  if (grant && !grant.revoked_at) {
    return `<p><span class="ok">Connected</span> as <strong>${h(grant.google_email || "your Google account")}</strong> since ${when(grant.granted_at)}.
      Every Mac on this account files to that Drive.
      <form method="post" action="/drive/disconnect" style="display:inline"><button>Disconnect</button></form></p>`;
  }
  const why = grant?.revoked_at ? `<p class="warn">The earlier connection stopped working: ${h(grant.revoked_reason || "it was revoked")}.</p>` : "";
  return `${why}<p class="muted">Connect once, and every Mac signed in to this account files its notes to your Drive. Syllabus only sees files it created.</p>
    <p><a href="/drive/connect"><button class="primary">Connect Google Drive</button></a></p>`;
}

/** Someone signed in, but not the person whose Mac this is. */
export function notYoursPage(email: string): string {
  return page(
    "Not yours",
    `<p>That Syllabus belongs to someone else. You are signed in as <strong>${h(email)}</strong>.</p>
     <p><form method="post" action="/logout" style="display:inline"><button>Use a different account</button></form></p>`,
  );
}

/**
 * The panel's Mac is not holding its connection to us right now: asleep,
 * offline, or the panel is not running. Shown in place of a timeout, and it
 * retries on its own.
 */
export function panelNotConnectedPage(deviceName: string, lastConnected: string, everConnected: boolean): string {
  const name = deviceName || "That Mac";
  const since = lastConnected ? `<p class="muted">Last connected ${when(lastConnected)}.</p>` : "";
  const how = everConnected
    ? `<p>Syllabus reaches this address on its own whenever its panel is running and the Mac is awake and online. Wake the Mac, or check <code style="font-size:1em;letter-spacing:0">intake service status</code> there.</p>`
    : `<p>Syllabus has not connected from that Mac yet. It does so on its own once the panel is running and the Mac is signed in to your account.</p>`;
  return page(
    `${h(name)} is not connected`,
    `${how}${since}<p class="muted">This page tries again every 10 seconds.</p>
     <p class="muted"><a href="/">Your account</a></p>`,
  ).replace("<title>", '<meta http-equiv="refresh" content="10"><title>');
}

export function codeForm(code: string, error: string): string {
  return `<form class="row" method="post" action="/device/approve">
      <input class="code" name="user_code" value="${h(code)}" placeholder="WXYZ-2345" autocomplete="off" required>
      <button class="primary">Connect</button>
      ${error ? `<span class="warn">${h(error)}</span>` : ""}
    </form>`;
}

export function devicePage(account: Account, code: string, deviceName: string, error: string): string {
  const intro = deviceName
    ? `<p>A Mac called <strong>${h(deviceName)}</strong> is asking to join <strong>${h(account.email)}</strong>.</p>`
    : `<p>Enter the code Syllabus is showing to connect that Mac to <strong>${h(account.email)}</strong>.</p>`;
  return page("Connect a Mac", intro + codeForm(code, error) + `<p class="muted"><a href="/">Your account</a></p>`);
}

export function approvedPage(account: Account, deviceName: string): string {
  return page(
    "Connected",
    `<p class="ok"><strong>${h(deviceName)}</strong> now belongs to ${h(account.email)}.</p>
     <p>Go back to Syllabus; it will notice within a few seconds.</p>
     <p class="muted"><a href="/">Your account</a></p>`,
  );
}
