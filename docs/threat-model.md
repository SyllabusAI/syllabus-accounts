# Threat model

What this service protects, from whom, and what stands in the way. Written
for the launch plan's security bar (P2) on 2026-09-26; keep it current when a
route, a secret, or a trust boundary changes.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Google identity of each account | `accounts` (sub, email, name) | It is the sign-in for everything below |
| Browser session | Signed cookie, 30 days, no server-side row | Whoever holds it administers the account |
| Device tokens | `device_tokens` (SHA-256 only) | Spend the account's allowance, read its schedule, mint Drive access tokens |
| Drive refresh tokens | `drive_grants`, AES-GCM under `DRIVE_KEY` | Standing access to the files Syllabus created in a person's Drive |
| Provider keys (Groq, OpenAI, Anthropic) | Worker secrets | Real money, shared by every account |
| Stripe secret key and webhook secret | Worker secrets | Checkout sessions; the webhook is the only thing that writes an allowance |
| Allowances and usage | `allowances`, `usage`, `topups` | Decide what an account may spend |
| Settings documents | `settings` | A person's class schedule |
| The relay | One Durable Object per device | Carries a browser into a panel on somebody's Mac |

## Actors

- **Anonymous internet.** Can reach every route. Wants free service, other
  people's data, or to take the service down.
- **Signed-in user with their own account.** Can do everything a user does,
  and will try to reach other accounts or spend beyond their plan.
- **Holder of a stolen device token.** A token copied off a laptop, from a
  backup, or from a log. Acts as that one Mac.
- **Malicious website** visited by a signed-in user. Can make the browser send
  requests carrying the session cookie (CSRF), frame pages (clickjacking), or
  send the user to crafted links.
- **Compromised panel.** The Mac itself, or code running as the panel. Holds a
  device token and answers relayed requests.
- **Operator.** Trace and Liam, with Cloudflare, Google Cloud, Stripe, and
  GitHub access. Trusted, but their laptops and accounts are targets.

## Trust boundaries

1. **Internet to Worker.** Everything arrives over TLS at Cloudflare's edge.
   `CF-Connecting-IP` is set by the edge and is the only client address used.
   An IPv6 address is keyed by its /64, which one home or phone can fill
   with fresh addresses at will (`clientAddress` in `src/limits.ts`).
2. **Browser session vs. device bearer.** One middleware resolves either into
   `c.var.account`; `authKind` records which. Routes that administer the
   account call `browserOnly()`, so a device token can never enroll a Mac,
   remove one, disconnect Drive, or buy anything.
3. **Worker to Google.** The code exchange and token refresh go straight to
   Google's token endpoint over TLS, with the client secret.
4. **Worker to Stripe.** Outbound calls use the secret key. Inbound webhooks
   are trusted only after the signature over the raw body checks out.
5. **Worker to panel (relay).** The Worker decides who may reach a panel; the
   panel trusts the viewer identity because it arrived on the socket it opened
   with its own token.
6. **Worker to providers.** The proxy fixes model, URL, prompt, and schema;
   the caller supplies only audio or a transcript and two labels.

## Routes and how each is authenticated

| Route | Auth | CSRF / abuse control |
|---|---|---|
| `GET /healthz`, `/privacy`, `/terms` | none | Static, no state |
| `GET /` | none or session | Read only |
| `GET /login` | none | Per-address limit (600 per 10 min); sets a signed flow cookie |
| `GET /oauth2/callback` | flow cookie (state, nonce, PKCE) | Per-address limit (600 per 10 min) before calling Google |
| `GET /logout` | session | Signs out only on `Sec-Fetch-Site: same-origin` or `none`; otherwise shows a button |
| `POST /logout` | session | `crossSiteGuard`, `sameOrigin` |
| `GET /me` | session or device | Read only |
| `POST /device/start` | none | Per-address limit, global pending cap |
| `POST /device/poll` | device code | Per-address limit answered as RFC 8628 `slow_down`, never 429 |
| `GET /device?code=` | session | 60 lookups per 10 min per account, 600 per address |
| `POST /device/approve` | session, `browserOnly` | `sameOrigin`; 30 per 10 min per account, 300 per address |
| `POST /device/revoke` | device | Bearer, not a cookie |
| `POST /devices/:id/revoke`, `/devices/revoke-all` | session, `browserOnly` | `sameOrigin` |
| `GET/PUT /settings/:name` | device | Bearer; 64K character cap |
| `GET /drive/connect` | session, `browserOnly` | Only starts a consent the person completes at Google |
| `POST /drive/token` | device | Bearer |
| `GET /drive/status` | session or device | Read only |
| `POST /drive/disconnect` | session, `browserOnly` | `sameOrigin` |
| `GET /relay/connect` | device | Bearer; WebSocket upgrade |
| `GET/POST /p/:device/*` | session, owner of the device | POST needs `sameOrigin`; path and method allowlist; 64 KB body |
| `POST /proxy/transcribe`, `/proxy/summarize` | device | Per-account per-minute limit, allowance reserved first, global ceiling, size caps |
| `GET /proxy/usage` | session or device | Read only |
| `POST /billing/checkout`, `/portal`, `/topup` | session, `browserOnly` | `sameOrigin`; per-account limit |
| `POST /stripe/webhook` | Stripe signature | Lenient per-address limit before the body is read; 256 KB cap; event id idempotency |

Every response carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, and HSTS. Pages the
Worker writes also carry a Content-Security-Policy that allows no script at
all. Every request body outside `/proxy/*` is capped at 512 KB before a
handler reads it.

## Top threats and what mitigates them

**1. A stolen device token spends money or reads data.**
Tokens are 256 bits, stored hashed, and shown once. The proxy reserves the
allowance before calling a provider, limits each account per minute, and a
global monthly ceiling bounds the whole bill. A device token cannot administer
the account (`browserOnly`), so it cannot enroll a replacement Mac or remove
the real one. The account page removes one Mac or all of them at once.
Open: tokens do not expire yet (a separate PR adds expiry).

**2. Guessing a device code to capture somebody else's Mac.**
A captured code would give the victim's panel a token for the guesser's
account, filing the victim's notes into the guesser's Drive. Codes are 8
characters from a 32-letter alphabet (about 10^12), live 10 minutes, at most
500 pending. Lookups and approvals are limited per account and per address.

**3. Cross-site requests with the session cookie.**
The cookie is `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only. That alone is
not the defense: Lax keeps the cookie off a cross-site form POST, but it does
not stop a request from a sibling host of the same site, and it is a browser
default some clients do not apply. So every state-changing browser route
also checks `sameOrigin` (Origin, or Referer when there is no Origin), and
`crossSiteGuard` (`src/session.ts`) runs once before every route and refuses
any POST, PUT, PATCH or DELETE the session cookie authenticates unless
`Sec-Fetch-Site` is absent or `same-origin` and `sameOrigin` agrees. No
route can forget the check. `GET /logout` only acts when the browser says
the navigation came from this site. Pages cannot be framed. The audit below
records the verdict for each route.

**4. Sign-in and Drive consent tampering.**
State ties the callback to the browser that started it; the nonce ties the ID
token to it; PKCE (S256) ties the code, so a code lifted from a redirect
cannot be redeemed elsewhere. The ID token's issuer, audience, expiry, and
verified email are checked. The `next` parameter is resolved like a browser
would resolve it and kept only when it stays on this origin.

**5. Reaching another account's panel through the relay.**
The Worker checks that the signed-in account owns the device before anything
reaches the Durable Object. Only `/`, `/setup`, `/api/*`, and `/static/*` by
GET or POST are carried; cookies and most headers are not; responses keep an
allowlist of headers and never set cookies.

**6. Forged Stripe events granting allowances.**
Only a delivery whose signature verifies is handled. With no webhook secret
set, every delivery is refused. Each event id is claimed once, so a replay
grants nothing.

**7. Leaked secrets.**
Secrets live only in Worker secrets and `.dev.vars` (gitignored). Upstream
error bodies are never forwarded or logged. A leaked `SESSION_SECRET` is fixed
by rotating it, which signs everyone out. A leaked `DRIVE_KEY` alone is
useless without the database; see [drive-key-rotation.md](drive-key-rotation.md)
for rotating it, and for what to do when both leak.

**8. Denial of service and cost amplification.**
Every route and the limit that covers it are listed in
[rate-limits.md](rate-limits.md). Open routes are rate limited per address; the device-code table has a global
cap; bodies are capped before they are read; the proxy has per-account and
global ceilings. Cloudflare absorbs volumetric floods in front of all of it.

## Known gaps, deliberately deferred

- **Sessions cannot be revoked one at a time.** The cookie is stateless;
  rotating `SESSION_SECRET` signs out everyone. A server-side session row
  would fix this and belongs with account deletion.
- **Device tokens do not expire.** In progress in a separate PR.
- **No `form-action` in the CSP.** Billing forms post here and are redirected
  to Stripe, and browsers apply `form-action` to that redirect, so the policy
  would have to name Stripe's hosts exactly. Every value on the pages is
  escaped, so the directive would guard against an injection that has no
  known way in.
- **The panel cookie lacks the `__Host-` prefix.** The session and sign-in
  flow cookies have it (CSRF audit, finding 2, closed). The prefix demands
  `Path=/`, and the panel cookie is deliberately scoped to one device's
  `/p/<device>` path, so it cannot take the prefix without one cookie name
  per device. What it would guard is small: a sibling host planting a panel
  cookie shows the visitor only the panel of a device the attacker owns, on a
  host that already serves the attacker's own scripts to whoever opens it,
  and two cookies of the name are refused (`panelViewer`).
- **An allowance row outlives a cancellation Stripe never delivers.** See the
  README's Billing section.
- **Per-address limits are coarse on shared networks.** Campus Wi-Fi and
  carrier-grade NAT put a whole lecture hall behind one public address, so
  per-address limits are ten times the per-account ones (600 sign-ins and
  callbacks, 300 approvals per 10 minutes) and only stop a script; the
  per-account limits hold each person to human rates.

## CSRF audit (0.6.0 launch bar, item 5)

Question: is `SameSite=Lax` enough on the routes the cookie authenticates?
No, not by itself, and it is not what the service relies on. Lax does not
apply to same-site requests from a sibling subdomain (the panel host, or any
other host under the parent domain), to browsers that ignore it, or to a
top-level navigation that a route wrongly treats as safe. The Origin and
`Sec-Fetch-Site` checks below carry the weight; Lax is a second layer.
`test/csrf.test.ts` sends every attack in the table's last column at every
route with the victim's cookie, in four content types, and checks the side
effect did not happen.

Attacks tried on each cookie route: foreign Origin, `Origin: null`, no Origin
or Referer, foreign Referer, sibling-subdomain and parent-domain Origin,
`Sec-Fetch-Site: cross-site` and `same-site` (with a correct Origin, to show
the header refuses alone), and form, multipart, `text/plain` and JSON bodies.

| Route | Auth | Result | Severity if it failed | Verdict |
|---|---|---|---|---|
| `POST /device/approve` | cookie | Refused by guard and `sameOrigin` | High: enrolls an attacker's Mac into the victim's account | Sound |
| `POST /devices/:id/revoke`, `/devices/revoke-all` | cookie | Refused by guard and `sameOrigin` | Medium: signs the victim's Macs out | Sound |
| `POST /drive/disconnect` | cookie | Refused by guard and `sameOrigin` | Medium: drops the Drive grant | Sound |
| `POST /account/delete` | cookie plus a recent Google sign-in | Refused by guard and `sameOrigin`; also needs the typed email | Critical: deletes the account | Sound, three independent locks |
| `POST /billing/checkout`, `/portal`, `/topup` | cookie | Refused by guard and `sameOrigin` before any Stripe call | Medium: starts a charge the victim then has to confirm at Stripe | Sound |
| `POST /logout` | cookie | Refused by guard and `sameOrigin` | Low: forced sign-out | Sound |
| `GET /logout` | cookie | Acts only on `Sec-Fetch-Site: same-origin` or `none`; else a button | Low | Sound |
| `POST/GET /p/:device/*` (no panel host) | cookie | POST refused by guard and `sameOrigin`; a panel's own scripts are same-origin, which is why the panel host exists | High while panels share the origin | Sound only with `PANEL_ORIGIN` set |
| Panel host `POST /p/:device/*` | panel cookie (its own) | Needs `Origin` equal to the panel host; account host does not count | Medium | Sound |
| `/settings`, `/proxy/*`, `/drive/token`, `/device/revoke`, `/relay/connect` | bearer only | A cookie gets 401; a browser never attaches a bearer token by itself | n/a | Not forgeable |
| `POST /device/start`, `/device/poll`, `/stripe/webhook` | none, device code, signature | No cookie is read | n/a | Not forgeable |
| `GET /drive/connect`, `GET /login` | cookie or none | Start a flow the person finishes at Google; the callback needs the signed flow cookie and state | Low: a cross-site link can open Google's consent screen | Accepted |
| `GET /device?code=` | cookie | Read only, but each lookup counts against the account's 60 per 10 minutes, so a cross-site link can burn some of that budget | Low: nuisance | Accepted |
| `GET /oauth2/callback` | flow cookie | Changes state, guarded by state, nonce, PKCE. One gap found and fixed, below | Medium before the fix | Fixed |

**Finding 1 (fixed, Medium, needs a script on a sibling host).** The sign-in
flow cookie was read even when the request carried two cookies of that name.
A script on a sibling host (a panel served from a subdomain is exactly that)
can start its own sign-in, keep the signed flow cookie it is given, set it on
the victim's browser with a `Domain` attribute, and send the victim to the
callback with its own state and code. The state check passes against the
planted cookie, and the victim's browser is signed in as the attacker's
account: anything the victim then uploads lands in the attacker's Drive. The
session and panel cookies already refused duplicates; the flow cookie now does
too (`src/google.ts`).

**Finding 2 (hardening, Low, closed).** The same tossing trick worked on the
session cookie when the victim had no session of their own: a lone planted
cookie was accepted. The session and sign-in flow cookies are now
`__Host-syllabus_accounts_session` and `__Host-syllabus_accounts_signin`: a
browser accepts a `__Host-` cookie only when it is `Secure`, `Path=/` and has
no `Domain`, so no other host can set one. The names from before are never
read and are expired on the next response, so the change signed everyone out
once. Over `http` (wrangler dev on localhost) the prefix cannot be used and
the cookies fall back to `syllabus_accounts_session_dev` and
`syllabus_accounts_signin_dev`; production is always https. Two cookies of
the new name are still refused. The panel cookie keeps its name; see Known
gaps.

**Finding 3 (hardening, done).** Every route carried its own `sameOrigin`
call and nothing else stopped a new route that forgot. `crossSiteGuard` closes
that, and adds `Sec-Fetch-Site` so the check no longer rests on the Origin
comparison alone. Tokens were not chosen: the cookie-authenticated surface is
form posts from pages this service writes, a same-origin check covers every
one of them, and a token would need threading through each form and would
still fail against a script on the same origin.

Not covered by any of this: a script running on the account origin itself.
That is what the panel host removes, and the reason `PANEL_ORIGIN` must be set
before panels are shown to anyone but their owners.

## 0.6.0 launch review

The launch review is [threat-model-0.6.md](threat-model-0.6.md), with the
OWASP ASVS Level 1 pass in [asvs-l1-checklist.md](asvs-l1-checklist.md) and the
key rotation runbook in [drive-key-rotation.md](drive-key-rotation.md). It
qualifies two statements above: the monthly ceiling in threats 1 and 8 counted
the seconds the caller's audio file says it had (finding F-01, fixed by PR #51), and panels are served off the account origin only once
`PANEL_ORIGIN` is set (finding F-02).
