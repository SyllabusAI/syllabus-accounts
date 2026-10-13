/** The few pages this Worker shows a person. Plain HTML, one stylesheet. */

import type { BillingView } from "./billing";
import type { DriveGrant } from "./db";
import type { Account, Device } from "./env";
import { isUpgrade, SELLABLE, TIERS, TRIAL_ALLOWANCE, TRIAL_PERIOD_DAYS, type TierName } from "./tiers";
import { escapeHtml as h, panelUrl } from "./util";

/**
 * The look is Syllabus's own, the same tokens as the Mac app's panel
 * (LectureAI intake/templates/setup.html) and the /syllabus/ pages on
 * maincoursemedia.com: a soft lavender canvas, white cards, purple pills.
 *
 * Two limits come from the page policy (headers.ts), which admits this one
 * sheet and loads nothing else. There is no web font: Lexend Deca is named
 * first and is used where it is installed, and the system face stands in
 * everywhere else. And the logo is inline SVG drawn here, not the app's
 * icon.png, because the policy loads no images.
 *
 * #8c52ff is 4.41:1 on white, under AA for body text, so it is decoration
 * only. Anything read in purple uses --deep. Every page carries no style=""
 * attribute (a test checks), so everything visual lives in this sheet.
 */
export const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #faf9fc; --card: #ffffff; --field: #fbfafd; --ink: #16131f; --muted: #6b6577;
    --line: #e7e3ee; --brand: #8c52ff; --deep: #6a35d9; --soft: #f3ecff;
    --btn: #6a35d9; --btn-hover: #5b2cc0;
    --ok: #128a5b; --ok-soft: #e7f6ef; --warn: #a65400; --warn-soft: #fdf1e3;
    --err: #c22f3d; --err-hover: #a8222f; --err-line: #f1c9cd;
    --shadow: 0 1px 2px rgba(22,19,31,.05), 0 8px 24px rgba(22,19,31,.06);
    --glow: rgba(140,82,255,.13); --bar: rgba(255,255,255,.86);
    --font: "Lexend Deca", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131019; --card: #1b1725; --field: #15111d; --ink: #f2eefb; --muted: #a49db4;
      --line: #2c2738; --deep: #c3a6ff; --soft: #241a3d;
      --btn: #7543e6; --btn-hover: #8c52ff;
      --ok: #4ecf9b; --ok-soft: #13271f; --warn: #e5a252; --warn-soft: #2a1f12;
      --err: #ff8792; --err-hover: #d23a48; --err-line: #4a2229;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.35);
      --glow: rgba(140,82,255,.16); --bar: rgba(27,23,37,.86);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    background: radial-gradient(760px 420px at 50% -120px, var(--glow), transparent 70%) no-repeat, var(--bg);
    color: var(--ink); font: 400 16px/1.6 var(--font); -webkit-font-smoothing: antialiased;
  }
  a { color: var(--deep); text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }
  strong { font-weight: 600; }

  .top { padding: 14px 16px 0; }
  .top-bar {
    max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 12px;
    padding: 8px 18px 8px 10px; background: var(--bar); border: 1px solid var(--line);
    border-radius: 999px; box-shadow: var(--shadow);
  }
  .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; }
  .brand svg { width: 32px; height: 32px; flex: none; display: block; }
  .brand-name { font-weight: 600; font-size: 1.05rem; letter-spacing: -.02em; }
  .brand-tag {
    margin-left: auto; background: var(--soft); color: var(--deep); font-size: .72rem; font-weight: 600;
    letter-spacing: .06em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px;
  }

  main { flex: 1; width: 100%; max-width: 760px; margin: 0 auto; padding: 40px 16px 56px; }
  h1 { font-size: clamp(1.7rem, 4.5vw, 2.2rem); line-height: 1.15; font-weight: 600; letter-spacing: -.025em; margin: 0 0 20px; }
  h2 { font-size: 1.15rem; line-height: 1.3; font-weight: 600; letter-spacing: -.015em; margin: 1.8em 0 .5em; }
  h3 { font-size: .8rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 1.6em 0 .4em; }
  p { margin: 0 0 .9em; }
  ul { margin: 0 0 1em; padding-left: 1.2em; }
  li { margin: .35em 0; }
  li::marker { color: var(--brand); }

  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 18px;
    box-shadow: var(--shadow); padding: 24px 26px; margin: 0 0 18px; overflow-wrap: anywhere;
  }
  .card > :first-child { margin-top: 0; }
  .card > :last-child { margin-bottom: 0; }
  section.danger { border-color: var(--err-line); }
  section.danger h2 { color: var(--err); }

  .muted { color: var(--muted); font-size: .92em; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  p.ok, p.warn { padding: 10px 14px; border-radius: 12px; font-size: .95em; }
  p.ok { background: var(--ok-soft); }
  p.warn { background: var(--warn-soft); }
  .lead { margin-top: 1.5em; }
  .nowrap { white-space: nowrap; }
  .inline { display: inline; }
  .flex { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .flex input { flex: 1 1 16em; }

  code { font: .92em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); color: var(--deep); padding: 1px 6px; border-radius: 6px; }
  code.plain { font-size: .92em; }

  input, select, button { font: inherit; font-size: .95rem; }
  input, select {
    padding: 10px 14px; border-radius: 12px; border: 1px solid var(--line);
    background: var(--field); color: var(--ink); min-width: 0;
  }
  input:focus, select:focus { outline: 2px solid var(--brand); outline-offset: 1px; border-color: var(--brand); }
  input::placeholder { color: var(--muted); opacity: .8; }
  input.code { font: 600 1.25rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; width: 11em; max-width: 100%; text-transform: uppercase; }
  select { cursor: pointer; }
  label { display: block; margin: 1.2em 0 .45em; font-weight: 500; font-size: .95rem; }

  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font-weight: 500; line-height: 1; padding: 11px 20px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--ink); box-shadow: var(--shadow);
    white-space: nowrap; transition: border-color .15s ease, color .15s ease, background .15s ease, transform .15s ease;
  }
  button:hover { border-color: var(--deep); color: var(--deep); transform: translateY(-1px); }
  button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  button.primary { background: var(--btn); border-color: transparent; color: #fff; box-shadow: 0 6px 18px rgba(106,53,217,.28); }
  button.primary:hover { background: var(--btn-hover); color: #fff; }
  button.danger { background: var(--err); border-color: transparent; color: #fff; box-shadow: none; }
  button.danger:hover { background: var(--err-hover); color: #fff; }
  a > button { pointer-events: none; }
  form.inline button { margin: 2px 0 2px 6px; padding: 8px 16px; font-size: .88rem; }

  form { margin: 0 0 1em; }
  form.inline { margin: 0; }
  form.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 1em 0; }
  form.row.tight { margin: .5em 0; }
  form.row .muted { font-size: .88em; }

  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; }
  td, th { text-align: left; padding: 12px 12px 12px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td:last-child { padding-right: 0; }
  table.macs, table.macs tbody { display: block; }
  table.macs { border-top: 1px solid var(--line); }
  table.macs tr { display: grid; grid-template-columns: 1fr auto; align-items: center; column-gap: 12px; row-gap: 6px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  table.macs tr:last-child { border-bottom: 0; }
  table.macs td { display: block; padding: 0; border: 0; }
  table.macs td:first-child, table.macs td[colspan] { grid-column: 1 / -1; }
  table.macs td.nowrap { white-space: normal; font-size: .85em; }
  table.macs td:last-child { text-align: right; }
  table.macs td[colspan] { text-align: left; }
  table.macs form { margin: 0; }
  table.macs form button { padding: 8px 16px; font-size: .88rem; }

  .site-foot { border-top: 1px solid var(--line); background: var(--card); }
  .site-foot-in {
    max-width: 760px; margin: 0 auto; padding: 22px 16px 28px; display: flex; flex-wrap: wrap;
    gap: 10px 24px; justify-content: space-between; align-items: center; font-size: .85rem; color: var(--muted);
  }
  .site-foot-in p { margin: 0; }
  .site-foot nav { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .site-foot a { color: var(--muted); text-decoration: none; }
  .site-foot a:hover { color: var(--deep); text-decoration: underline; }

  @media (max-width: 560px) {
    main { padding-top: 28px; }
    .card { padding: 20px 18px; border-radius: 16px; }
    .brand-tag { font-size: .68rem; }
    form.inline button { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } button:hover { transform: none; } }
`;

/**
 * The app icon, drawn inline: a purple tile with "Sy" and the three ticks.
 * Inline because the page policy loads no images.
 */
const LOGO = `<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><rect width="512" height="512" rx="112" fill="#8c52ff"/><text x="104" y="384" fill="#fff" font-family="Arial Rounded MT Bold, Lexend Deca, Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="280" letter-spacing="-10">Sy</text><g stroke="#fff" stroke-width="28" stroke-linecap="round" fill="none"><path d="M343 104l4 80"/><path d="M381 190l34-48"/><path d="M396 212l66-28"/></g></svg>`;

const HEADER = `<header class="top"><div class="top-bar">
  <a class="brand" href="/">${LOGO}<span class="brand-name">Syllabus</span></a>
  <span class="brand-tag">Account</span>
</div></header>`;

const SITE_FOOTER = `<footer class="site-foot"><div class="site-foot-in">
  <p>A product of Main Course Media LLC.</p>
  <nav aria-label="About Syllabus"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/SyllabusAI/LectureAI">Syllabus on GitHub</a></nav>
</div></footer>`;

/**
 * One page. The body goes in a single card, unless `sections` says the body
 * brings its own cards (the account page, one per section).
 */
export function page(title: string, body: string, opts: { sections?: boolean } = {}): string {
  const content = opts.sections ? body : `<div class="card">${body}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · Syllabus</title><style>${STYLE}</style></head>
<body>${HEADER}<main><h1>${h(title)}</h1>${content}</main>${SITE_FOOTER}</body></html>`;
}

export function landing(): string {
  return page(
    "Syllabus accounts",
    `<p class="muted">Syllabus records your lectures on your Mac and files study notes in your Google Drive.
        Sign in to connect a Mac running Syllabus to your account.</p>
     <p><a href="/login"><button class="primary">Sign in with Google</button></a></p>`,
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
     `,
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
    `<p class="muted">Last updated October 12, 2026.</p>
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
           stops until the next month or until you upgrade. You are never billed for going over.</li>
       <li><strong>Upgrading.</strong> While your plan is active and set to renew, you can move to a bigger plan from
           your account page. We charge the difference
           between the two plans' monthly prices right away, plus any sales tax, and your hours for the month go up
           once that payment goes through. Your plan then renews at the new price on its usual date. To move to a
           smaller plan, cancel, then choose the smaller plan once your current month ends.</li>
     </ul>
     <h3>Refunds</h3>
     <ul>
       <li><strong>Canceling.</strong> Cancel any time under Manage billing on your account page. You keep your plan's
           hours until the end of the month you have paid for, and you are not charged again. Canceling does not refund
           the current month.</li>
       <li><strong>Deleting your account.</strong> We cancel your plan and refund the unused part of the current month
           to your card, in proportion to the time left, including any upgrade you paid for that month. Tax is refunded
           in the same proportion.</li>
       <li><strong>If we end Syllabus.</strong> If we stop offering Syllabus, we will give you at least 30 days' notice
           and refund any month you have paid for and not received.</li>
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
     `,
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
    `${billingNotice(notice)}<section class="card"><p>Signed in as <strong>${h(account.email)}</strong>${account.name ? ` (${h(account.name)})` : ""}.
        <form method="post" action="/logout" class="inline"><button>Sign out</button></form></p></section>
     <section class="card">
     <h2>Your Macs</h2>
     <p class="muted">Each Mac's panel has an address here that only you can open, from any browser or phone, whenever that Mac is awake and its panel is running. A Mac that goes 90 days without using Syllabus is signed out and can sign in again from its Setup page.</p>
     <table class="macs"><tbody>${rows}</tbody></table>
     ${devices.length ? signOutEverything : ""}
     </section>
     <section class="card">
     <h2>Your plan</h2>
     ${billingSection(billing)}
     </section>
     <section class="card">
     <h2>Google Drive</h2>
     ${driveSection(grant)}
     </section>
     <section class="card">
     <h2>Connect a Mac</h2>
     <p class="muted">Syllabus shows a code on its Setup page. Enter it here.</p>
     ${codeForm("", "")}
     </section>
     <section class="card danger">
       <h2>Delete your account</h2>
       <p class="muted">This removes your Macs, your class schedule, your Google Drive connection, your plan, and your
          usage history from Syllabus, for good. Your recordings and notes stay on your Mac and in your Google Drive.</p>
       <p><a href="/account/delete"><button>Delete your account</button></a></p>
     </section>`,
    { sections: true },
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
  if (notice === "upgraded") {
    return `<p class="ok">Thanks. Stripe is moving you to the bigger plan. The new hours show below as soon as it confirms, usually within a moment.</p>`;
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
  const sub = view.subscription;
  // The SAME number the proxy enforces (allowanceFor in src/proxy.ts).
  const allowedSeconds = view.allowance?.audio_seconds ?? TRIAL_ALLOWANCE.audio_seconds;
  const left = Math.max(0, allowedSeconds - view.audioUsed);
  const canUpgrade = Boolean(sub && renewing(sub) && SELLABLE.some((t) => isUpgrade(sub.tier, t.tier)));
  const usedLine = view.audioUsed <= 0
    ? `<p class="muted">Nothing recorded this month. All ${hours(allowedSeconds)} are yours.</p>`
    : left <= 0
      ? `<p class="warn">All ${hours(allowedSeconds)} are used. Recording is stopped until the month turns over${canUpgrade ? " or you upgrade below" : ""}, and nothing is being billed for going over.</p>`
      : `<p class="muted">${hours(view.audioUsed)} of ${hours(allowedSeconds)} used this month. ${hours(left)} left.</p>`;

  const manage = view.hasCustomer
    ? `<form method="post" action="/billing/portal" class="inline"><button>Manage billing</button></form>`
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
    // Stripe to do so by the time anybody reads this, so the answer here is
    // the plan arriving.
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
    return `<p><strong>${h(name)}</strong>, $${priceOf(sub.tier)} a month.</p>${state}${renewal}${usedLine}
      ${renewing(sub) ? upgradeOffer(sub.tier, left <= 0) : ""}
      <p>${manage}</p>${renewing(sub) ? downgradeNote(sub.tier) : ""}`;
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
 * The way in for somebody with a code from us.
 *
 * Its own form because it is its own kind of session: no trial, since the
 * code is the free time. Checkout cannot know in advance that a code will be
 * typed into it, so the person says so here instead.
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

/** Active and not set to end: the only kind of plan that can be upgraded. */
function renewing(sub: { status: string; cancel_at_period_end: number }): boolean {
  return sub.status === "active" && !sub.cancel_at_period_end;
}

/**
 * The bigger plans, each a button. The price comes on the next page, before
 * anything is charged (POST /billing/upgrade without confirm=1).
 */
function upgradeOffer(tier: string, capped: boolean): string {
  const bigger = SELLABLE.filter((t) => isUpgrade(tier, t.tier));
  if (!bigger.length) return "";
  const buttons = bigger
    .map(
      (t) => `<form method="post" action="/billing/upgrade" class="row tight">
        <input type="hidden" name="tier" value="${h(t.tier)}">
        <button${capped ? ` class="primary"` : ""}>Upgrade to ${h(t.label)}</button>
        <span class="muted">${h(t.note)}</span>
      </form>`,
    )
    .join("");
  return `<p class="muted lead">${capped ? "Need more hours this month?" : "Want more hours?"} Upgrading charges the
      difference between the two plans right away, and the new hours start as soon as it goes through.</p>${buttons}`;
}

/** Moving down is not a button: it waits for the paid month to end. */
function downgradeNote(tier: string): string {
  if (!SELLABLE.some((t) => isUpgrade(t.tier, tier))) return "";
  return `<p class="muted">Want a smaller plan? Cancel under Manage billing, then choose the smaller plan here once
      this one ends. You keep your current hours until then.</p>`;
}

/**
 * The page between an Upgrade button and the charge. Says what it costs,
 * what it buys, and when the plan next renews, before anything moves.
 */
export function upgradeConfirmPage(from: TierName, to: TierName, periodEnd: string): string {
  const now = TIERS[from];
  const next = TIERS[to];
  const difference = next.price_usd - now.price_usd;
  const label = (t: TierName) => SELLABLE.find((s) => s.tier === t)?.label ?? tierName(t);
  const study = next.assistant_sessions > 0 ? `, plus ${next.assistant_sessions} study sessions` : "";
  const renews = onDate(periodEnd);
  return page(
    `Upgrade to ${label(to)}`,
    `<p>You are on <strong>${h(label(from))}</strong>, $${now.price_usd} a month for ${now.audio_hours} hours.
        <strong>${h(label(to))}</strong> is $${next.price_usd} a month for ${next.audio_hours} hours${study}.</p>
     <p>Upgrading charges <strong>$${difference} now</strong>, plus any sales tax, to the card you pay with. That is
        the difference between the two plans for this month. This month's hours go up to ${next.audio_hours} as soon
        as the payment goes through, and your plan then renews at $${next.price_usd} a month${renews ? ` from ${renews}` : ""}.</p>
     <form method="post" action="/billing/upgrade" class="row">
       <input type="hidden" name="tier" value="${h(to)}">
       <input type="hidden" name="confirm" value="1">
       <button class="primary">Upgrade and pay $${difference}</button>
     </form>
     <p class="muted"><a href="/">Keep my current plan</a></p>`,
  );
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
    `${name} is not connected`,
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
