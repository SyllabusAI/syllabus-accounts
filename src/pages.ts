/** The few pages this Worker shows a person. Plain HTML, one stylesheet. */

import type { BillingView } from "./billing";
import type { DriveGrant } from "./db";
import type { Account, Device } from "./env";
import { SELLABLE, TIERS, TOPUP, TRIAL_ALLOWANCE, TRIAL_PERIOD_DAYS, type TierName } from "./tiers";
import { escapeHtml as h, panelUrl } from "./util";

export const STYLE = `
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
  .foot { margin-top: 3em; }
  .lead { margin-top: 1.5em; }
  .nowrap { white-space: nowrap; }
  .inline { display: inline; }
  .flex { display: flex; gap: 0.6em; flex-wrap: wrap; }
  form.row.tight { margin: 0.4em 0; }
  code.plain { font-size: 1em; letter-spacing: 0; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Syllabus</title><style>${STYLE}</style></head>
<body><h1>${h(title)}</h1>${body}</body></html>`;
}

const FOOTER = `<p class="muted foot"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="https://github.com/SyllabusAI/LectureAI">Syllabus on GitHub</a></p>`;

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

/** Where legal notices to the company are sent by post. */
const ADDRESS = "Main Course Media LLC, 5900 Balcones Drive, Suite 100, Austin, Texas 78731";

export function privacyPage(): string {
  return page(
    "Privacy",
    `<p class="muted">Last updated September 29, 2026.</p>
     <p>Syllabus records lectures on your Mac and turns them into transcripts, study notes, and study tools. Your
        recordings, transcripts, and notes are stored on your Mac and, if you connect it, in your own Google Drive. They
        are not kept in our database.</p>
     <p>Syllabus is operated by Main Course Media LLC, a Texas limited liability company ("Syllabus," "we," "us," or
        "our"). This policy says what we keep, what passes through our service without being kept, which companies help
        us run Syllabus and what each one receives, how long things are kept, and what you can ask us to do.</p>

     <h2>What we keep</h2>
     <ul>
       <li><strong>Your account.</strong> When you sign in with Google we keep your Google account id, email address, and
           display name.</li>
       <li><strong>Your Macs.</strong> For each Mac you connect: its name, when it connected, when it last checked in,
           its panel address, and a one-way hash of the token that identifies it. The token itself stays on the Mac.</li>
       <li><strong>Panel address.</strong> Each connected Mac runs a small control page called its panel, where you see
           your recordings and settings. The panel address is the web address at which this service can show you that
           page in a browser when you are away from the Mac. We keep it so the link on your account page works. Anyone
           who opens it without being signed in to your Syllabus account is turned away; the address alone gives no
           access, and nobody else can see the panel.</li>
       <li><strong>Your settings.</strong> The text of your class schedule, so it can follow you to another Mac.</li>
       <li><strong>Your Google Drive connection.</strong> Described under "Google user data" below.</li>
       <li><strong>Your plan, usage, and payments.</strong> Your plan, its status and renewal date, and the identifiers
           Stripe gives your customer record, subscription, and purchases. Each month we also count the hours of audio
           you used, the size of each summary, and how many study assistant sessions you opened, with what each cost us.
           These are numbers. They do not include what was said or asked. We do not keep your card number; Stripe does.</li>
       <li><strong>Email.</strong> If you write to us we keep the message and our reply. We send you email about your
           account, billing, and changes to these pages. We do not send marketing email.</li>
       <li><strong>Service logs.</strong> Our application logs name an account or a Mac by its id, never by a name or
           email address, and never contain audio, transcripts, summaries, or your questions. Our hosting provider,
           Cloudflare, also keeps its own short-lived request records, which can include IP addresses and browser
           details, to run and secure the service.</li>
       <li><strong>Sign-in cookies.</strong> This service sets only the cookies it needs to sign you in and keep you
           signed in. We use no advertising or analytics cookies, and no analytics or crash-reporting tools.</li>
       <li><strong>Update checks.</strong> The Mac app periodically asks GitHub whether a newer version has been
           released. That request goes from your Mac to GitHub, not through us.</li>
     </ul>

     <h2>What passes through us and is not kept</h2>
     <p>On the trial or a paid plan, Syllabus uses our own accounts with the providers below instead of keys of your own.
        Your Mac sends the request to this service, our server forwards it to the provider, and the answer comes back
        the same way:</p>
     <ul>
       <li><strong>Lecture audio</strong>, in short pieces, sent for transcription.</li>
       <li><strong>Transcripts</strong>, sent to be summarized.</li>
       <li><strong>Summaries, transcripts, and your questions</strong>, sent to the study assistant.</li>
       <li><strong>Your Mac's panel pages</strong>, when you open the panel from a browser.</li>
     </ul>
     <p>None of this is written to our database or our logs. What we keep is the usage count described above. A request
        runs on Cloudflare's servers for as long as it takes to hand it on, and no longer.</p>

     <h2>Who else handles your information</h2>
     <h3>Service providers</h3>
     <table><tbody>
       <tr><td><strong>Google</strong></td><td>Signs you in and receives your name, email, and Google account id for
           that. If you connect Drive, holds the notes Syllabus files there.</td></tr>
       <tr><td><strong>Stripe</strong></td><td>Takes payments. Receives your email, card and billing details, and
           purchases, and calculates sales tax.</td></tr>
       <tr><td><strong>Cloudflare</strong></td><td>Hosts this service and its database, and carries requests to and
           from it.</td></tr>
       <tr><td><strong>GitHub</strong></td><td>Serves the app's update information. Sees your IP address when your Mac
           checks for a new version.</td></tr>
     </tbody></table>
     <h3>AI providers</h3>
     <table><tbody>
       <tr><td><strong>Groq</strong></td><td>Receives lecture audio to transcribe it.</td></tr>
       <tr><td><strong>OpenAI</strong></td><td>Receives lecture audio to transcribe it when Groq is unavailable.</td></tr>
       <tr><td><strong>Anthropic</strong></td><td>Receives transcripts, summaries, and your questions to write summaries
           and answer study questions.</td></tr>
     </tbody></table>
     <p>We send each AI provider only what its feature needs, through its business API. We do not use your recordings,
        transcripts, notes, or questions to train any model, and we have not opted in to any program that lets a
        provider train on them. Each provider applies its own rules to API requests, which can include short-term
        retention and, in limited cases such as abuse investigations, review by the provider's staff. We do not
        control those rules and they can change; see the privacy policies of
        <a href="https://groq.com/privacy-policy">Groq</a>,
        <a href="https://openai.com/policies/privacy-policy">OpenAI</a>, and
        <a href="https://www.anthropic.com/legal/privacy">Anthropic</a>. If you would rather none of this leave your
        Mac and this service, use Syllabus with API keys of your own.</p>
     <p>If you use your own API keys, your Mac talks to those providers directly. Nothing in the list above passes
        through us, and that provider's own terms apply to those requests.</p>

     <h2>Google user data</h2>
     <ul>
       <li><strong>What we access.</strong> Your name, email address, and Google account id when you sign in. If you
           connect Drive, the <code>drive.file</code> permission, which reaches only files and folders Syllabus itself
           creates. It cannot see anything else in your Drive.</li>
       <li><strong>How we use it.</strong> Only to sign you in and to let your own Macs file transcripts and notes in
           your Drive. We do not use Google data for advertising, do not sell it, and do not let people read it except
           as needed for security, to comply with law, or with your consent.</li>
       <li><strong>How it is stored.</strong> The refresh token Google issues is stored encrypted. It is used only to
           obtain short-lived access tokens, which are handed to your own signed-in Macs. The Macs never receive the
           refresh token. Your notes go from your Mac to your Drive. They do not pass through our servers.</li>
       <li><strong>Who it is shared with.</strong> Only Google, and Cloudflare as our host. Neither Stripe nor any AI
           provider receives Google user data.</li>
       <li><strong>How it is deleted.</strong> Disconnecting Drive revokes the grant at Google and deletes the stored
           refresh token. Deleting your account does the same and erases the rest of your account. Files Syllabus
           already filed in your Drive stay there until you delete them.</li>
     </ul>
     <p>Syllabus's use and transfer of information received from Google APIs adheres to the
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data
        Policy</a>, including the Limited Use requirements.</p>

     <h2>How we use information</h2>
     <p>Only to run Syllabus for you: signing you in, connecting your Macs, syncing your settings, filing notes to your
        Drive, transcribing and summarizing your lectures, running the study assistant, billing your plan, keeping the
        service working and secure, preventing abuse and fraud, answering you, and complying with law. We do not sell
        your personal information, share it with advertisers, or use it to build profiles.</p>

     <h2>How long we keep it</h2>
     <ul>
       <li>Account, Mac, settings, and usage records: until you delete your account.</li>
       <li>Stripe payment records: Stripe keeps its own record of past payments as the law and its rules require. We
           keep only the identifiers and dates needed for accounting, tax, and payment disputes.</li>
       <li>Email you send us: until it is no longer needed to help you or to meet a legal duty.</li>
       <li>Logs: short-lived, kept by Cloudflare under its own schedule.</li>
       <li>Deleted accounts: backups can hold data for a short time before they are overwritten.</li>
       <li>After a deletion we keep one thing: a one-way scrambled identifier made from your Google sign-in, used only
           to stop the free trial being given out twice. It cannot be turned back into your name or email, and nothing
           else is kept with it.</li>
     </ul>

     <h2>Where it lives</h2>
     <p>On Cloudflare, in a database that belongs to this service, in the United States and wherever Cloudflare
        operates. Traffic to and from it is encrypted, and stored credentials are encrypted. No online system is
        perfectly secure, and we cannot promise otherwise.</p>

     <h2>Your choices and rights</h2>
     <ul>
       <li><strong>In your account.</strong> Remove a Mac (its token stops working at once), disconnect Google Drive,
           cancel billing, or delete your account, all from your account page. Deleting cancels any plan and refunds the
           unused part of the current month, signs out every Mac, revokes Drive, deletes your saved card and billing
           details from Stripe, and erases the rest. Your recordings, transcripts, and notes on your Mac and in your
           Drive are yours and are not deleted for you.</li>
       <li><strong>By email.</strong> Write to ${CONTACT} to ask what we hold about you, to correct it, to delete it,
           to receive a copy in a common format, or to ask us to stop using it in a way that is not needed to run
           Syllabus. We do not sell personal data, use it for targeted advertising, or use it for profiling that
           produces legal or similarly significant effects, so there is nothing further to opt out of.</li>
       <li><strong>Proving it is you.</strong> We will ask you to write from the email address on your account, or to
           sign in, and may ask one or two questions about the account. We will not ask for more than we need.</li>
       <li><strong>Someone acting for you.</strong> An authorized agent may write on your behalf with your written
           permission, and we may confirm it with you.</li>
       <li><strong>Our answer.</strong> We reply within 45 days. If we need more time we will say so and may take up to
           45 more. If we decline a request we will explain why.</li>
       <li><strong>Appeal.</strong> If you disagree with our answer, reply to it within 60 days with the word "appeal"
           and your reason. We will answer in writing within 60 days of your appeal. If it is still denied, you may
           contact the Texas Attorney General at texasattorneygeneral.gov.</li>
     </ul>

     <h2>Legal requests and business changes</h2>
     <p>We may disclose information when we reasonably believe the law, a court order, or valid legal process requires
        it, or to investigate fraud, abuse, or a security problem, or to protect Syllabus, our users, or others. If
        Main Course Media LLC is sold, merged, or reorganized, information about Syllabus accounts may go to the
        successor, which must honor this policy.</p>

     <h2>Age</h2>
     <p>Syllabus is for people 18 and older. We do not knowingly keep an account for anyone younger, and we delete one
        when we learn of it.</p>
     <h2>Changes</h2>
     <p>When this page changes in a way that matters, we update the date at the top and email account holders before the
        change takes effect.</p>
     <h2>Contact</h2>
     <p>${ADDRESS}. ${CONTACT}</p>
     <p>The code for this service is open source at
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
     <p>These terms are an agreement between you and Main Course Media LLC, a Texas limited liability company ("we,"
        "us," or "our"), for Syllabus, its Mac app, its website, and this account service. By creating an account or using
        Syllabus you accept them. If you do not accept them, do not use Syllabus. Section headings are for convenience
        and do not change what a section means. "Including" means "including without limit."</p>

     <h2>Who can use it</h2>
     <p>You must be 18 or older and able to enter a binding agreement. One account is for one person.</p>
     <h2>Your account</h2>
     <p>You are responsible for what happens under your account and for keeping your Google account, your Mac, and any
        API keys you connect secure. Give us accurate account and billing details. Do not sell, rent, or share access to
        your account.</p>

     <h2>Your recordings are your responsibility</h2>
     <p>Syllabus is for recording and studying lectures you attend. <strong>Syllabus does not ask for, collect, or
        confirm permission from anyone you record, and neither do we.</strong> Getting that permission is entirely your
        responsibility, and so is any legal consequence of recording without it.</p>
     <p>Recording laws differ from place to place. Some require the consent of everyone who can be heard, and schools,
        instructors, and employers can set rules stricter than the law. Each time you record, you are telling us that
        you have every permission the recording needs: from your instructor, from anyone else who can be heard, under
        your school's rules, and under every law that applies where you record. Do not use Syllabus to record private
        conversations, or to copy, share, or sell course material you have no right to.</p>
     <p>We do not review, monitor, or control what you record, and we are not a party to any recording you make.</p>

     <h2>Your content</h2>
     <p>You keep all rights you have in your recordings, transcripts, questions, and notes ("Your Content"). You give us
        a limited, nonexclusive permission to process Your Content only as needed to run Syllabus for you: to transcribe
        and summarize it, run the study assistant, move it between your Macs and services, keep the service secure, and
        comply with law, as the <a href="/privacy">privacy page</a> describes. This gives us no ownership of it.</p>
     <p>You agree to defend us against, and repay us for, third-party claims and the resulting losses, costs, and
        reasonable legal fees, to the extent they come from (a) your recording anyone without their permission where the
        law or a rule required it, (b) Your Content infringing or violating someone else's rights, or (c) your use of Syllabus in
        breach of these terms or the law. This does not apply to claims caused by our own breach of these terms.</p>

     <h2>Plans, trial, and billing</h2>
     <ul>${plans}</ul>
     <ul>
       <li><strong>Trial.</strong> Every plan starts with ${TRIAL_ALLOWANCE.audio_seconds / 3600} hours of lecture audio
           to try it. We ask for a card at the start and do not charge it until those hours are used or ${TRIAL_PERIOD_DAYS}
           days have passed, whichever comes first. One trial per person.</li>
       <li><strong>Automatic renewal.</strong> A plan renews every month and your card is charged the plan's price, plus
           any sales tax, until you cancel. We will email you before a price goes up, and a new price starts only at
           your next renewal.</li>
       <li><strong>Hours.</strong> A plan's hours are for its month and do not carry over. When they run out, recording
           stops until the next month or until you add hours. You are never billed for going over.</li>
       <li><strong>Extra hours.</strong> You can buy ${TOPUP.audio_hours} more hours for $${TOPUP.price_usd} as a
           one-time payment. They are for the current month and do not carry over.</li>
     </ul>
     <h3>Refunds</h3>
     <ul>
       <li><strong>Canceling.</strong> Cancel any time under Manage billing on your account page. You keep your plan's
           hours until the end of the month you have paid for, and you are not charged again. Canceling does not refund
           the current month.</li>
       <li><strong>Deleting your account.</strong> We cancel your plan and refund the unused part of the current month
           to your card, in proportion to the time left. Tax is refunded in the same proportion.</li>
       <li><strong>Extra hours.</strong> Extra hours are not refundable once bought, except as this section says: if
           you were charged in error, if the law requires a refund, or if you delete your account and the purchase was
           made after the deletion.</li>
       <li><strong>If we end Syllabus.</strong> If we stop offering Syllabus, we will give you at least 30 days' notice
           and refund any month you have paid for and not received, and any extra hours not yet used.</li>
       <li><strong>Billing errors.</strong> If you were charged the wrong amount, or twice, write to ${CONTACT} within
           60 days and we will correct it and refund the difference.</li>
       <li><strong>Where the law says otherwise.</strong> We will give any refund the law requires. Refunds go to the
           original card and can take several business days to appear.</li>
       <li><strong>Codes.</strong> A promotion code from us is personal, may end, may be withdrawn if it was obtained or
           used improperly, and has no cash value.</li>
     </ul>

     <h2>Acceptable use</h2>
     <p>Do not resell access, get around the limits on your plan, send anything to the service other than lectures and
        your own study questions, look for weaknesses in or attack the service except through a program we have
        authorized, upload malicious code, use it to break the law, or interfere with the service or other people's use
        of it. We may suspend or close an account that does, and we will tell you why unless the law or an urgent
        security problem prevents it.</p>
     <h2>AI output</h2>
     <p>Transcripts, summaries, and study assistant answers are made by AI. They can be wrong, incomplete, misheard, or
        invented. Do not treat them as an exact record of a lecture or an authoritative source. Check anything
        important against the lecture and your course materials. Follow your school's rules on using AI in coursework;
        we do not promise that your school allows it.</p>
     <h2>Other companies' services</h2>
     <p>Syllabus depends on services run by others, including AI, payment, Google, and hosting providers, under their own
        terms. We do not control them. They can change or stop, and we may replace a provider when we reasonably need to
        keep Syllabus running.</p>
     <h2>Our property and open source</h2>
     <p>Except for Your Content and open-source and third-party material, we keep our rights in Syllabus, including its
        name, branding, hosted service, and design. Parts of Syllabus are open source, and the license on those parts
        governs your rights to them. It does not give you our name, branding, private systems, or paid service.</p>
     <h2>Feedback</h2>
     <p>If you send us a suggestion or bug report, we may use it without owing you anything. This gives us no ownership of
        Your Content.</p>
     <h2>Ending your use</h2>
     <p>You may stop using Syllabus at any time. We may suspend or end your access if you materially break these terms,
        use the service fraudulently, put it or others at risk, leave a payment unpaid after we have tried to collect it,
        or the law requires it. Where we reasonably can we will tell you first and give you a chance to fix the problem.
        Sections that by their nature should continue, including those on ownership, indemnity, warranty, liability, and
        disputes, do.</p>
     <h2>Changes to the service and these terms</h2>
     <p>Syllabus may change, and features may be added or removed. If we change these terms in a way that matters, we
        will email you before the change takes effect; using Syllabus after that means you accept the new terms. If you
        do not accept them, stop using Syllabus and cancel before they take effect. Your recordings and notes stay on
        your Mac and in your Google Drive whether or not the service continues.</p>

     <h2>No warranty</h2>
     <p>SYLLABUS IS PROVIDED "AS IS" AND "AS AVAILABLE." TO THE EXTENT THE LAW ALLOWS, WE MAKE NO WARRANTY OF ANY KIND,
        EXPRESS OR IMPLIED, INCLUDING THAT SYLLABUS WILL BE ACCURATE, UNINTERRUPTED, ERROR-FREE, FREE OF DATA LOSS, FIT
        FOR A PARTICULAR PURPOSE, OR ACCEPTED BY YOUR SCHOOL, OR THAT OTHER COMPANIES' SERVICES WILL STAY AVAILABLE.
        Nothing here removes a right the law does not let us remove.</p>
     <h2>Limits on liability</h2>
     <p>TO THE EXTENT THE LAW ALLOWS, MAIN COURSE MEDIA LLC AND ITS MEMBERS, OFFICERS, EMPLOYEES, AND AGENTS ARE NOT
        LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL LOSS, INCLUDING LOST DATA, LOST
        PROFITS, LOST GRADES OR OTHER ACADEMIC CONSEQUENCES, OR LOSS FROM RELYING ON AI OUTPUT. OUR TOTAL LIABILITY FOR
        ANY CLAIM ARISING FROM SYLLABUS OR THESE TERMS IS LIMITED TO THE GREATER OF WHAT YOU PAID US IN THE 12 MONTHS
        BEFORE THE CLAIM AROSE AND $100. These limits do not apply to liability the law does not allow us to limit.</p>
     <h2>Events outside our control</h2>
     <p>We are not responsible for delay or failure caused by things beyond our reasonable control, such as internet or
        power outages, disasters, government action, cyberattacks, or the failure of another company's service.</p>

     <h2>Law and courts</h2>
     <p>These terms are governed by the laws of the State of Texas, without regard to its conflict of law rules. Any
        dispute belongs in the state courts located in Dallas County, Texas, or the federal court for that county, and you
        and we both agree to their jurisdiction. Either of us may use a small-claims court where it applies, and nothing
        here waives a right that cannot be waived.</p>
     <h2>The rest</h2>
     <ul>
       <li><strong>If part is unenforceable,</strong> the rest still applies, and that part is enforced as far as the law
           allows.</li>
       <li><strong>No waiver.</strong> If we do not enforce something right away, we can still enforce it later.</li>
       <li><strong>Assignment.</strong> You may not transfer your account or these terms without our written permission.
           We may transfer them as part of a merger, sale, or reorganization of Syllabus.</li>
       <li><strong>No third-party beneficiaries.</strong> These terms give rights only to you and to us, apart from the
           people named in the limits on liability.</li>
       <li><strong>Electronic communications.</strong> You agree that we may give you notices and other messages by email
           to the address on your account, or on this website, and that they count as written. Keep that address
           current.</li>
       <li><strong>Notices to us.</strong> Send legal notices by mail to ${ADDRESS}, or by email to ${CONTACT}
           with "Legal notice" in the subject. Email notices take effect when we reply to confirm we have them.</li>
       <li><strong>Whole agreement.</strong> These terms, the <a href="/privacy">privacy page</a>, and any extra terms
           shown for a particular plan or feature are the whole agreement between us about Syllabus and replace earlier
           ones on the same subject.</li>
     </ul>
     <h2>Contact</h2>
     <p>${ADDRESS}. ${CONTACT}</p>
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
                  <td class="muted nowrap">last seen ${when(d.last_seen_at)}</td>
                  <td><form method="post" action="/devices/${h(d.id)}/revoke"><button>Remove</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No Macs yet. Open the Setup page in Syllabus and choose Sign in to a Syllabus account.</td></tr>`;
  return page(
    "Your Syllabus account",
    `${billingNotice(notice)}<p>Signed in as <strong>${h(account.email)}</strong>${account.name ? ` (${h(account.name)})` : ""}.
        <form method="post" action="/logout" class="inline"><button>Sign out</button></form></p>
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
       <div class="flex">
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
    ? `<form method="post" action="/billing/portal" class="inline"><button>Manage billing</button></form>`
    : "";
  // Offered when the hours are gone, which is the only moment it is the right
  // answer. A cap is a hard stop, so this is the way past one, and it is one
  // click rather than a bill that arrives later.
  const topUp = view.canTopUp && left <= 0
    ? `<p><form method="post" action="/billing/topup" class="inline"><button class="primary">Add ${TOPUP.audio_hours} hours for $${TOPUP.price_usd}</button></form>
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
  return `<p class="muted lead">Have a code from us?</p>
    <form method="post" action="/billing/checkout" class="row">
      <input type="hidden" name="redeem" value="1">
      <select name="tier">${options}</select>
      <button>Redeem a code</button>
    </form>`;
}

function tierButtons(): string {
  return SELLABLE.map(
    (t) => `<form method="post" action="/billing/checkout" class="row tight">
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
 * For a Mac that was lost, a token that may have been copied, or a browser
 * left signed in somewhere: removing the Macs one at a time is not enough if
 * whoever holds the token can connect more while you work, so this ends every
 * connection and every other browser session in one go. The browser that
 * presses it stays signed in (revoke-all in devices.ts).
 */
const signOutEverything = `<p class="muted">Lost a Mac, or think someone else has a copy of its connection or your sign-in?
  <form method="post" action="/devices/revoke-all" class="inline"><button>Sign out everywhere</button></form>
  This signs out every Mac and every other browser signed in to this account. Each Mac asks for a new code the next time you open it.</p>`;

function driveSection(grant: DriveGrant | null): string {
  if (grant && !grant.revoked_at) {
    return `<p><span class="ok">Connected</span> as <strong>${h(grant.google_email || "your Google account")}</strong> since ${when(grant.granted_at)}.
      Every Mac on this account files to that Drive.
      <form method="post" action="/drive/disconnect" class="inline"><button>Disconnect</button></form></p>`;
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
     <p><form method="post" action="/logout" class="inline"><button>Use a different account</button></form></p>`,
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
    ? `<p>Syllabus reaches this address on its own whenever its panel is running and the Mac is awake and online. Wake the Mac, or check <code class="plain">intake service status</code> there.</p>`
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

/** "just now", "1 minute ago", "7 minutes ago": how long a pending Mac has been asking. */
export function askedAgo(createdAt: string, nowMs = Date.now()): string {
  const minutes = Math.floor((nowMs - Date.parse(createdAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

/**
 * The approval page. A link with the code filled in is how the Mac opens it,
 * and also how a phisher would send it (F-04): the name is whatever the
 * requesting Mac chose. So the page says when the request started and, every
 * time, what approving gives away, and the person decides with both in view.
 */
export function devicePage(account: Account, code: string, deviceName: string, error: string, askedAt = ""): string {
  const when = askedAt ? ` It asked ${askedAgo(askedAt)}.` : "";
  const intro = deviceName
    ? `<p>A Mac called <strong>${h(deviceName)}</strong> is asking to join <strong>${h(account.email)}</strong>.${when}</p>`
    : `<p>Enter the code Syllabus is showing to connect that Mac to <strong>${h(account.email)}</strong>.</p>`;
  const warning = `<p class="warn">Only continue if you started signing in to Syllabus on your own Mac in the last few minutes. If someone sent you this link or this code, close this page: connecting their Mac would let it record into your account and file notes in your Google Drive.</p>`;
  return page("Connect a Mac", intro + warning + codeForm(code, error) + `<p class="muted"><a href="/">Your account</a></p>`);
}

export function approvedPage(account: Account, deviceName: string): string {
  return page(
    "Connected",
    `<p class="ok"><strong>${h(deviceName)}</strong> now belongs to ${h(account.email)}.</p>
     <p>Go back to Syllabus; it will notice within a few seconds.</p>
     <p class="muted"><a href="/">Your account</a></p>`,
  );
}
