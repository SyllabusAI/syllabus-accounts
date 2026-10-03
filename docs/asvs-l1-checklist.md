# OWASP ASVS Level 1 pass

HOME-STRETCH "The security bar", item 4: a manual pass against ASVS Level 1
and the Syllabus-specific surface (device tokens, the relay Durable Object,
the Drive grant). Done 2026-09-29 against `syllabus-accounts` `main` at
`64253e3`, by reading the source and running the test suite (384 tests
passing before this branch's additions). **Re-checked 2026-10-02** against
`main` at `23b19f8` (635 tests passing): rows whose result changed say so.

Requirement numbers follow **ASVS 4.0.3**, and the wording is abbreviated to
what was checked. If you audit against ASVS 5.0, the chapters are reorganized;
map by topic. This service has no passwords, no SQL string building, no
uploads it stores, and no scripts in its own pages, which is why so many rows
are N/A. Nothing was tested against production.

**Results:** Pass, Fail (with a severity), N/A (with the reason), or
Unverified (a setting outside the repo that someone has to look at).
Findings carry the IDs from [threat-model-0.6.md](threat-model-0.6.md).

## Result

| Result | Rows |
|---|---|
| Fail, **High** (blocking) | S2.8 (F-02) |
| Fail or Partly, Medium | 3.3.1 (F-03, plain logout); S1.9 (F-04); S4.7 (F-06); S5.2, S5.3 (F-07) |
| Fail or Partly, Low | 14.4.2 (accepted), 14.4.3 (relayed pages), S4.8 (F-10, F-12) |
| Fixed since 2026-09-29 | 11.1.3, S4.4 (F-01, F-21); 3.4.4 (F-03); 4.2.2 (CSRF guard merged); S3.6 (F-08); 2.7.2 (F-17); 8.2.1 (F-20); S3.7 (F-11) |
| Unverified | 8.3.3, 9.1.2, 9.1.3 (and the "Always Use HTTPS" note under 9.1.1) |
| Everything else | Pass or N/A, each with its reason |

F-05 (a browser session is remote control of the Mac's panel) is not a failed
row: it is the product working as designed, triaged in the threat model.

**Blocking for launch:** F-02 (`PANEL_ORIGIN` is empty, so relayed panels run
on the account origin), until it is set or accepted in writing. F-01 was fixed
by PR #51 and F-21 by PR #62. There are no critical findings.

## V1 Architecture

ASVS 4.0.3 has no Level 1 requirements in V1. The architecture is in
[threat-model.md](threat-model.md).

## V2 Authentication

Sign-in is Google OpenID Connect; the service never sees a password.

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 2.1.1-2.1.12 | Password length, composition, storage, paste, strength meter | N/A | No passwords; identity is Google's (`src/google.ts`) |
| 2.2.1 | Anti-automation on authentication | Pass | `/login`, `/oauth2/callback` limited per address (`src/limits.ts:38-42`, `src/google.ts:118`, `:150`); device claim limited per account and address (`src/devices.ts:87`, `:133-140`, `:159-165`); `test/security.test.ts` "rate limits on the routes that answer strangers", `test/attacks.test.ts` |
| 2.2.2 | Weaker authenticators are not a fallback for stronger ones | Pass | One authenticator (Google); no "forgot password" or SMS path |
| 2.3.1 | System-generated initial passwords | N/A | No passwords |
| 2.5.4 | No default or shared accounts | Pass | Accounts are created only at a Google sign-in (`src/db.ts:15`) |
| 2.5.6 | Secure credential recovery | N/A | Delegated to Google |
| 2.7.1 | Out of band verifier not via PSTN | N/A | No SMS or voice. The device code is applied by analogy below |
| 2.7.2 | Out of band request, code or token expires after 10 minutes | Pass | Fixed 2026-10-02: a device code lives 10 minutes (`CODE_SECONDS = 600` in `src/devices.ts`); `test/devices.test.ts` "hands out a code a person can type" checks `expires_in`. F-17 |
| 2.7.3 | Out of band verifier usable once | Pass | Approval is a conditional update (`src/db.ts:237`), collection likewise (`:253`); `test/devices.test.ts` "hands the token out once", "refuses a code that was already used" |
| 2.7.4 | Out of band over a secure channel | Pass | TLS only (see V9) |
| 2.8.1 | Time-based OTP has a defined lifetime | N/A | No OTP |

## V3 Session management

The session is a stateless signed cookie (`src/session.ts`); the panel host
adds a second, per-device cookie (`src/panel-host.ts`).

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 3.1.1 | Session tokens never in URLs | Pass | Cookie only. The panel host's ticket is in a URL for at most 60 seconds, single use, redirect answered `Referrer-Policy: no-referrer` (`src/panel-host.ts:192-198`, `:171`); it is not a session token |
| 3.2.1 | A new session token on authentication | Pass | `setSession` mints a new signed value at every sign-in (`src/google.ts:210`, `src/session.ts:38`) |
| 3.2.2 | Session tokens have at least 64 bits of entropy | Pass | The value is an HMAC-SHA256 over `{account, issued}` under `SESSION_SECRET`; it cannot be guessed or forged without the secret. Refused outright when the secret is unset (`src/session.ts:34`, `test/security.test.ts` "the session secret") |
| 3.2.3 | Tokens kept in the browser only with secure methods | Pass | A cookie; the pages contain no script, so nothing reads or stores it elsewhere (`src/headers.ts:29`) |
| 3.3.1 | Logout and expiration invalidate the session | **Partly (Medium)** | Re-checked 2026-10-02. "Sign out everywhere" bumps `session_version`, which the cookie carries and `sessionMiddleware` checks, so it ends every browser session (PR #55; `test/session-version.test.ts`); bulk revoke bumps it too. A plain logout still only clears the cookie, so a copied cookie survives an ordinary sign-out until it expires in 30 days. F-03 |
| 3.3.2 | Periodic re-authentication (30 days at L1) | Pass | Absolute 30 days (`src/session.ts:19`, checked at `:70`) |
| 3.4.1 | Cookie `Secure` | Pass | `secure: PUBLIC_URL.startsWith("https://")` (`src/session.ts:43`); production is https |
| 3.4.2 | Cookie `HttpOnly` | Pass | `src/session.ts:42`, and the panel cookie `src/panel-host.ts:214` |
| 3.4.3 | Cookie `SameSite` | Pass | `Lax` (`src/session.ts:44`). Not relied on alone; see 4.2.2 |
| 3.4.4 | Cookie uses the `__Host-` prefix | Pass | Re-checked 2026-10-02: `__Host-syllabus_accounts_session` and `__Host-..._signin`; the old names are expired and never read (PR #48; `test/session-cookie.test.ts`). F-03 |
| 3.4.5 | Most precise `Path` when the domain hosts other apps | Pass | Account cookie is host-only (no Domain), path `/`; the panel cookie is scoped to `/p/<device>/` (`src/panel-host.ts:204`) |
| 3.5.3 | Stateless tokens are signed against tampering, replay, null cipher, key substitution | Pass | HMAC-SHA256 via Hono's signed cookies; separate derived keys for panel tickets and panel cookies with their own labels (`src/panel-host.ts`). Replay is closable by a `session_version` bump (3.3.1) |
| 3.7.1 | Re-authentication or a full session before sensitive transactions | Pass | Account deletion needs a Google sign-in in the last 10 minutes and the typed email (`src/account.ts:80-125`). Other sensitive actions need the session plus a same-origin post |

## V4 Access control

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 4.1.1 | Access control enforced on a trusted server layer | Pass | One auth middleware resolves the caller (`src/index.ts:52-88`); routes call `browserOnly` (`src/session.ts:137`) or require a device |
| 4.1.2 | Users cannot change the attributes access decisions use | Pass | The account id comes from the resolved credential, never from a request field (`src/db.ts` WHERE clauses); `test/isolation.test.ts` |
| 4.1.3 | Least privilege | Pass | A device token cannot administer the account (approve, remove, Drive connect or disconnect, billing, delete). `test/devices.test.ts` "a device token is not a person" |
| 4.1.5 | Access controls fail securely | Pass | Missing `SESSION_SECRET` refuses (`src/session.ts:34`); missing webhook secret refuses every delivery (`src/stripe.ts:72`); a bad `PANEL_ORIGIN` relays nothing (`src/relay.ts:150-154`); a dead bearer never falls back to a cookie (`test/isolation.test.ts`) |
| 4.2.1 | No IDOR on sensitive data and APIs | Pass | Every query is scoped by account in SQL. `test/isolation.test.ts` (PR #42): settings, Drive grants, usage, study sessions, two credentials, revocation |
| 4.2.2 | Strong anti-CSRF on authenticated functionality | Pass | Re-checked 2026-10-02: the central `crossSiteGuard` (`Sec-Fetch-Site` plus `sameOrigin`) runs on every route (`app.use("*")`, PR #48); `test/csrf.test.ts` "every cookie-authenticated route that changes something refuses another site" |
| 4.3.1 | Administrative interfaces use MFA | N/A | There is no administrative interface; operators use Cloudflare, GitHub and Stripe directly (F-07) |
| 4.3.2 | No directory browsing, no metadata files served | Pass | The Worker serves no static files; unmatched paths are 404 (`src/index.ts:145`) |

## V5 Validation, sanitization and encoding

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 5.1.1 | Resistant to HTTP parameter pollution | Pass | Handlers read one value by name (`c.req.query`); a duplicated cookie is refused (`src/session.ts:56`, `src/panel-host.ts:229`) |
| 5.1.2 | No mass assignment | Pass | Fields are picked explicitly (`src/settings.ts:45`, `src/devices.ts:91`) |
| 5.1.3 | Input validated against an allowlist | Pass | `NAME` (`src/settings.ts:20`), `PROFILES` (`src/devices.ts:26`), tier names (`src/billing.ts:50`), relayed paths (`src/relay.ts:42`), user codes (`src/util.ts` `normalizeUserCode`) |
| 5.1.4 | Structured data typed and validated | Pass | Hand-written checks on every body: `src/proxy.ts:391-394`, `src/assistant.ts:355-440`, `src/settings.ts:46-47` |
| 5.1.5 | Redirects only to trusted destinations | Pass | `safeNext` resolves like a browser (`src/google.ts:57`), the ticket landing is a path only (`src/panel-host.ts:182`). A relayed panel can still send `Location` (F-15, Low) |
| 5.2.1 | Untrusted HTML is sanitized | Pass | Every interpolated value goes through `escapeHtml` (`src/util.ts:84`); `src/pages.ts` calls it as `h()`; the only unescaped values are constants and numbers |
| 5.2.2 | Unstructured data is sanitized | Pass | Names and labels are trimmed and capped (`src/devices.ts:83`, `src/proxy.ts:290`) |
| 5.2.3 | Injection into mail systems | N/A | No mail is sent |
| 5.2.4 | No `eval` or dynamic code | Pass | None in `src/` (searched: `eval(`, `new Function`, `innerHTML`) |
| 5.2.5 | No template injection | Pass | No template engine; template literals with escaping |
| 5.2.6 | No SSRF | Pass | Every outbound URL is a constant (Google, Stripe, Groq, OpenAI, Anthropic: `src/google.ts:31-33`, `src/drive.ts` `REVOKE_URL`, `src/proxy.ts:82-88`); no URL from a caller is fetched |
| 5.2.7, 5.2.8 | SVG, sandboxed scripting | N/A | Neither exists |
| 5.3.1-5.3.3 | Output encoding for context, charset, XSS | Pass | HTML escaped; JSON via `c.json`; a hash-based CSP with no script on every page the Worker writes (`pagePolicy` in `src/headers.ts`, PR #49; `test/csp.test.ts`) |
| 5.3.4, 5.3.5 | Parameterized queries | Pass | Every query uses `.bind()`; the only interpolations are constants (`src/db.ts:889`, `src/assistant.ts` `undoTake`) |
| 5.3.6 | No JavaScript or JSON injection | Pass | No script on any page the Worker writes |
| 5.3.7-5.3.10 | LDAP, OS command, file inclusion, XPath | N/A | None exist |
| 5.5.1 | Serialized objects are integrity-checked | Pass | Only JSON; the assistant's continuation is rebuilt block by block (`src/assistant.ts:385-434`) |
| 5.5.2 | XML parsers hardened | N/A | No XML |
| 5.5.3, 5.5.4 | No unsafe deserialization; `JSON.parse` not `eval` | Pass | `JSON.parse` only; a deeply nested body throws and is answered 400 (`src/proxy.ts:474-480`) |

## V6 Stored cryptography

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 6.2.1 | Cryptographic modules fail securely, no padding-oracle style leaks | Pass | AES-GCM authenticated; a failed open throws and the route answers `grant_unreadable` without saying why (`src/drive.ts:123-131`); `test/attacks.test.ts` "a sealed Drive grant cannot be bent" |

Level 1 has nothing more in V6. Noted, not failed: `DRIVE_KEY` is turned into
an AES key by one SHA-256 with no stretching and no length check
(`src/crypto.ts:15`), which is safe only for a random key (F-13, Low; the
runbook says 32 random bytes).

## V7 Error handling and logging

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 7.1.1 | No credentials or payment details in logs | Pass | Every line goes through `scrub` (`src/log.ts:21`): emails, query strings, bearer tokens, Google, Stripe and provider key shapes. `test/logs.test.ts`, `test/no-pii-in-logs.ts` |
| 7.1.2 | No other sensitive data in logs beyond need | Pass | Account and device ids only (SECURITY.md "What the logs hold"); upstream error bodies are dropped (`src/proxy.ts:179`) |
| 7.4.1 | A generic message when something unexpected happens | Pass | `app.onError` answers "Something went wrong" (`src/index.ts:146`) |

## V8 Data protection

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 8.2.1 | Anti-caching headers on sensitive data | Pass | Fixed 2026-10-02: `securityHeaders` adds `Cache-Control: no-store` to every HTML and JSON answer that does not set its own (`src/headers.ts`); relayed panels default to `no-store` in the relay. `test/security.test.ts` "puts the safe headers". F-20 |
| 8.2.2 | No sensitive data in browser storage | Pass | No script, no storage |
| 8.2.3 | Client-side data cleared after the session | N/A | Nothing is kept client-side |
| 8.3.1 | Sensitive data not in the URL | Pass | A single-use OAuth code (standard), a single-use 60 second ticket, and a device *user code*, which is not a credential until approved |
| 8.3.2 | Users can remove or export their data | Pass | `/account/delete` removes every row (`src/account.ts`, `src/db.ts:889`); Stripe and Drive are ended first. There is no export route, which the "or" allows |
| 8.3.3 | Clear privacy language, consent updated | Unverified | `/privacy` and `/terms` are live (PR #45, merged 2026-09-29) but the lawyer has not reviewed them and the owners have not signed off. Not judged here |
| 8.3.4 | Sensitive data identified and protected | Pass | The asset tables in [threat-model.md](threat-model.md) and [threat-model-0.6.md](threat-model-0.6.md) |

## V9 Communications

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 9.1.1 | TLS for all client connectivity | Pass | The Worker is served on a Cloudflare custom domain; HSTS on every response (`src/headers.ts:37`, `:53`); cookies `Secure`. Whether the zone forces http to https is a Cloudflare setting (Unverified: SSL/TLS, Edge Certificates, "Always Use HTTPS") |
| 9.1.2 | Strong TLS configuration | Unverified | Cloudflare terminates TLS. Check the zone's minimum TLS version is 1.2 or higher |
| 9.1.3 | Only current TLS versions enabled | Unverified | Same setting |

## V10 Malicious code

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 10.3.2 | No code loaded from untrusted sources; integrity protections | Pass | No third-party script or stylesheet on any page (CSP would block it); dependencies from a lockfile (`npm ci` in `.github/workflows/ci.yml`). Every GitHub Action is pinned to a full commit SHA, the release in a comment (F-19, fixed 2026-10-02) |

## V11 Business logic

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 11.1.1 | Steps processed in order, none skipped | Pass | Device claim: pending, approved, collected, in that order and once each (`src/devices.ts:171-183`, `:208-213`); checkout precedes an allowance, which only the webhook writes |
| 11.1.2 | Flows processed in realistic human time | Pass | Approval is limited to 30 per 10 minutes per account (`src/limits.ts:56`), sign-in per address, proxy to 20 and 5 per minute (`src/proxy.ts:140`) |
| 11.1.3 | Limits on business actions, enforced per user | Pass | Re-checked 2026-10-02. F-01 is fixed: the charge is at least `bytes / 24000` up front and settles up to the provider's measured duration (PR #51; `test/meter-floor.test.ts`, `test/threat-model-claims.test.ts` "the transcription meter", no longer `it.fails`). F-21 (the `quality=high` pass has no measured duration to settle to) is closed by refusing that pass until it is bound to one (PR #62) |
| 11.1.4 | Anti-automation against exhaustion and excessive uploads | Pass | Rate limits, body caps counted as bytes arrive, the pending-code cap, the global spend ceiling (`GLOBAL_CEILING`); `test/spend-limits.test.ts`, `docs/rate-limits.md` (PR #47) lists every route |

## V12 Files and resources

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 12.1.1 | Large files cannot fill storage | Pass | Audio is streamed to the provider and never stored; 12 MiB cap counted as bytes arrive (`src/proxy.ts:112`, `:257`); everything else is capped at 512 KB (`src/headers.ts:27`) |
| 12.3.1 | User filenames not used to build paths | Pass | `audio.name` goes to the provider as a label only (`src/proxy.ts:332`); no file is written |
| 12.3.2-12.3.5, 12.4.1, 12.5.2 | Extensions, execution, storage of uploads | N/A | Nothing is stored or served |
| 12.5.1 | Only needed file types are served | Pass | No static serving |
| 12.6.1 | No SSRF from the web tier | Pass | See 5.2.6 |

## V13 API and web service

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 13.1.1 | Same encodings and parsers across components | Pass | JSON and form bodies parsed by the Worker only |
| 13.1.3 | API URLs expose no keys or session tokens | Pass | See 3.1.1 and 8.3.1 |
| 13.2.1 | HTTP methods match the action, and are enabled deliberately | Pass | GET for reads, POST for changes, PUT for settings; unmatched methods are 404 |
| 13.2.2 | Request bodies are schema-validated | Pass | Hand-written, per route (5.1.4) |
| 13.2.3 | CSRF protection on RESTful services that use cookies | Pass | Origin and Referer checks (`src/session.ts:116`), `SameSite=Lax`; bearer routes ignore cookies (`test/isolation.test.ts` "two credentials on one request") |

## V14 Configuration

| ID | Requirement | Result | Evidence |
|---|---|---|---|
| 14.2.1 | Components current and free of known vulnerabilities | Pass | `npm audit --omit=dev`: 0 vulnerabilities (2026-10-02). `npm audit` including dev tooling: 3 moderate and 1 high, all in `undici` inside `miniflare`/`wrangler`/`vitest-pool-workers`, used by the local test runner and not part of the deployed bundle. Dependabot alerts on since 2026-10-03 (F-07) |
| 14.2.2 | Unneeded features and sample content removed | Pass | Nothing beyond the routes in the route table |
| 14.2.3 | Assets from a CDN carry integrity checks | N/A | No external assets |
| 14.3.2 | Debug modes off | Pass | No debug routes; errors are generic (`src/index.ts:146`) |
| 14.3.3 | No version information in headers | Pass | No `Server` or `X-Powered-By` set by the Worker |
| 14.4.1 | Every response has a safe `Content-Type` and charset | Pass | `c.json`, `c.html`, `c.text` set them; relayed responses keep the panel's `content-type` (`src/panel-relay.ts:78`) |
| 14.4.2 | API responses carry `Content-Disposition: attachment` | Fail (Low, accepted) | Not set. `X-Content-Type-Options: nosniff` and `application/json` make a JSON body inert in a browser. Not worth the header |
| 14.4.3 | A CSP as defense in depth | Pass on the account origin; Partly (Low) on relayed pages | Every page the Worker writes carries the hash CSP (`pagePolicy`). Relayed pages now carry the panel's own nonce CSP (`content-security-policy` is in the relay's `RESPONSE_HEADERS`, PR #49), but that policy is written by whoever holds the device token, and on the account origin the Worker adds none of its own. The panel host adds `PANEL_CSP` on top. Root cause is F-02 |
| 14.4.4 | `X-Content-Type-Options: nosniff` on all responses | Pass | `src/headers.ts:46`, also on the panel host (`src/panel-host.ts:266`); `test/security.test.ts` "security headers" |
| 14.4.5 | HSTS on all responses | Pass | `max-age=31536000; includeSubDomains` (`src/headers.ts:37`) |
| 14.4.6 | A `Referrer-Policy` | Pass | `same-origin`, and `no-referrer` on ticket redirects (`src/headers.ts:52`, `src/panel-host.ts:196`) |
| 14.4.7 | Content cannot be embedded in other sites | Pass | `X-Frame-Options: DENY` and `frame-ancestors 'none'` (`src/headers.ts:47`, `:29`; panel host `:259`, `:265`) |
| 14.5.1 | Only the HTTP methods in use are accepted | Pass | Hono answers 404 for anything unregistered; relayed panels take GET and POST only (`src/relay.ts:39`) |
| 14.5.2 | `Origin` is not used to authenticate | Pass | Authentication is the cookie or the bearer. `Origin` is a second lock on cookie mutations, which 13.2.3 allows; `browserOnly` is the first lock (`src/session.ts:110-115`) |
| 14.5.3 | CORS uses a strict allowlist | Pass | The Worker sends no `Access-Control-*` header, so browsers refuse cross-origin reads |
| 14.5.4 | Headers added by trusted proxies are authenticated | Pass | The only proxy header trusted is `CF-Connecting-IP` (`src/limits.ts:96`), set by Cloudflare's edge, which a Worker on a custom domain cannot be reached around (`test/attacks.test.ts` "the client address comes from the edge and nowhere else") |

---

## Syllabus-specific surface

Not ASVS rows, but the same standard of evidence. IDs prefixed S.

### Device tokens and the device flow

| ID | Check | Result | Evidence |
|---|---|---|---|
| S1.1 | Token is 256 random bits | Pass | `newDeviceToken` (`src/util.ts`): 32 bytes from `crypto.getRandomValues` |
| S1.2 | Only a hash is stored | Pass | `sha256Hex` at insert (`src/devices.ts:217`), looked up by hash (`src/db.ts:143`) |
| S1.3 | Shown once | Pass | Minted at collection; `collected_at` set first (`src/devices.ts:211-217`); `test/devices.test.ts` "hands the token out once" |
| S1.4 | Unused tokens expire | Pass | 90 idle days, sliding, `test/expiry.test.ts` |
| S1.5 | One Mac or all can be revoked, and a thief's replacements die with the token | Pass | `src/db.ts:87`, `:123`; `test/devices.test.ts` "signing out every Mac" |
| S1.6 | Device code (`device_code`) unguessable and hashed | Pass | 256 bits (`randomId(32)`), stored as SHA-256 (`src/devices.ts:106`, `:113`) |
| S1.7 | User code hard to guess in the window | Pass | 32^8, about 10^12, 10 minutes, 500 pending, 30 approvals per 10 minutes per account and 300 per address |
| S1.8 | Only a browser session can approve a code | Pass | `browserOnly` and `sameOrigin` (`src/devices.ts:150-154`) |
| S1.9 | The approver can tell whose Mac they are enrolling | Partly (Medium) | Re-checked 2026-10-02: the page shows the requester-chosen name, how long ago the request started, and a warning that a link or code someone else sent must not be approved (`devicePage`; `test/devices.test.ts` "shows the Mac's name to the person approving it"). It still cannot show where the request came from; that needs the requesting country kept with the code. F-04 |
| S1.10 | Token stored safely on the Mac | Pass (Low note) | 0600 file in a 0700 directory, atomic write (LectureAI `intake/config.py` `write_private`). A Keychain item would be stronger |

### The relay Durable Object

| ID | Check | Result | Evidence |
|---|---|---|---|
| S2.1 | Only the device's owner reaches its object | Pass | `ownedDevice` before any stub call (`src/relay.ts:96`, `:163`); `test/relay.test.ts`, `test/isolation.test.ts` |
| S2.2 | A revoked device's socket is unreachable | Pass | `deviceById` filters `revoked_at IS NULL` (`src/db.ts:277`) |
| S2.3 | Requests: method and path allowlist, header allowlist, size cap | Pass | `src/relay.ts:39-47`, `src/panel-relay.ts:76`, `:60` |
| S2.4 | Responses: header allowlist, no cookies, size cap | Pass | `src/panel-relay.ts:78`, `:58`, `:254` |
| S2.5 | A client cannot invoke `forget` or `state` or impersonate another device | Pass | The Worker overwrites `X-Relay-Op` and `X-Relay-Device` (`src/relay.ts:72-76`) |
| S2.6 | The Mac checks who is asking | Pass | `intake/signin.py:139-170` |
| S2.7 | The real panel cannot be displaced by a token holder | **Fail (part of F-02)** | Newest connection wins (`src/panel-relay.ts:212`). Inherent to one-token-one-Mac; the mitigation is not letting the panel's page be trusted, which is S2.8 |
| S2.8 | The panel's pages cannot reach the account pages | **Fail as deployed (High, F-02)** | `PANEL_ORIGIN` is `""` in `wrangler.jsonc:62`. Code and tests for the separate host exist (PR #41, `test/panel-host.test.ts`); configuration is the gap |
| S2.9 | Cross-site POSTs to a relayed panel are refused | Pass | `src/relay.ts:162`, `src/panel-host.ts:345`; `test/relay.test.ts`, `test/panel-host.test.ts` |

### The Drive grant

| ID | Check | Result | Evidence |
|---|---|---|---|
| S3.1 | AES-GCM with a fresh random IV each time | Pass | 12 random bytes per seal (`src/crypto.ts:38`); `test/attacks.test.ts` "never reuses an IV" |
| S3.2 | Scope is `drive.file` only | Pass | `DRIVE_SCOPE` (`src/drive.ts`), checked at consent (`:70-97`) |
| S3.3 | The refresh token never leaves the service | Pass | `/drive/token` returns an access token that lasts an hour (`src/drive.ts:123-160`) |
| S3.4 | Disconnect and account deletion revoke at Google | Pass | `revokeGrantAtGoogle` (`src/drive.ts:190`), best effort by design |
| S3.5 | A key rotation exists and is tested | Pass | [drive-key-rotation.md](drive-key-rotation.md); `test/security.test.ts`, `test/threat-model-claims.test.ts` |
| S3.6 | A leaked key plus database can be answered in bulk | Pass | `scripts/bulk-revoke.mjs` and [bulk-revoke.md](bulk-revoke.md) (PR #54): dry run by default, `--execute`, idempotent, resumable, bumps `session_version`; `test/bulk-revoke.test.ts`. F-08 |
| S3.7 | The Drive consent is bound to the account that started it | Pass | Fixed 2026-10-02: the flow cookie carries the account id and `finishConnect` refuses a callback for any other account before calling Google (`test/drive.test.ts` "attaches the grant only to the account that started the flow"). The flow cookie is also `__Host-` and a planted duplicate is refused. F-11 |
| S3.8 | A refresh-token grant isolates accounts | Pass | `test/isolation.test.ts` "a Drive grant" |

### The proxy and billing

| ID | Check | Result | Evidence |
|---|---|---|---|
| S4.1 | Model, URL, prompt, schema fixed; caller supplies data only | Pass | `src/proxy.ts:82-91`, `src/assistant.ts:69-108`, `:478-508` |
| S4.2 | Provider keys cannot appear in a response or log | Pass | See threat model T3; `src/log.ts` |
| S4.3 | Spend reserved atomically, per account and in total | Pass | `src/db.ts:518`; `test/spend-limits.test.ts` (PR #43) |
| S4.4 | Audio seconds charged from something the caller cannot lie about | Pass | See 11.1.3 (F-01 fixed by PR #51, F-21 by PR #62) |
| S4.5 | Summary and assistant spend settled to the provider's own usage | Pass | `src/proxy.ts:549-553`, `src/assistant.ts` `costOf` |
| S4.6 | Only Stripe can write an allowance | Pass | Signature over the raw body, replay-proof event ids (`src/stripe.ts:71-118`, `src/db.ts:729`) |
| S4.7 | A refund cannot exceed what was earned | Fail (Medium, F-06) | Time-prorated, blind to use (`src/stripe.ts:441-473`) |
| S4.8 | One trial per person | Partly (Low) | One trial per Google identity, kept across deletion (`trial_used`). One per card is built and off: `TRIAL_CARD_CHECK` ends a trial whose card already started another account's (`test/trial-card.test.ts`), waiting on a privacy line. The trial key has its own secret, `TRIAL_SECRET` (F-12) |

### Repository and deployment

| ID | Check | Result | Evidence |
|---|---|---|---|
| S5.1 | Nothing merges without CI | Pass | Branch protection requires `check` and `prompt-parity`, with admins enforced (GitHub API, read only) |
| S5.2 | Deploy only from reviewed `main` | Partly (Medium, F-07) | Since 2026-10-03 `production` deploys only from `main` and needs Trace or Liam to approve each deploy, which also covers `workflow_dispatch`. Pull requests still do not require a review |
| S5.3 | Secret scanning and push protection on a public repo | Pass | Both on since 2026-10-03, with Dependabot alerts, here and in LectureAI |
| S5.4 | No secrets in the repo | Pass | `.dev.vars` is gitignored; `.dev.vars.example` holds names only |

## Triage of every Medium

Written decisions are in the threat model
([Triage of every Medium](threat-model-0.6.md#triage-of-every-medium)). In
short: F-03 fix before launch if time allows; F-04 accept for 0.6.0 and fix
soon; F-05 accept (by design) once F-02 is closed; F-06 decide before the first
paid month ends; F-07 fix before launch (settings only); F-08 runbook fixed
here, script recommended before launch. **No Medium blocks launch. F-01 and
F-02 do.**

## What would turn this into a clean pass

1. ~~F-01: floor the charge by bytes today, settle to the provider's duration next.~~
   Done (PR #51; F-21 closed by PR #62).
2. F-02: set `PANEL_ORIGIN` on a second registrable domain (or accept in writing).
3. F-03 (plain logout) and F-07 as triaged. F-08 is done (PR #54).
4. The three Unverified rows: someone with the Cloudflare dashboard looks at
   "Always Use HTTPS" and the minimum TLS version, and the owners read PR #45.
