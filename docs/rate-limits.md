# Rate limits, route by route

Every route this service answers, who can reach it, and what stops a script
from hammering it. This is the evidence for the security bar's "rate limiting
on every unauthenticated and semi-authenticated endpoint" item, and the
threat model's item 8 points here. When you add a route, add a row.

All limits are fixed windows in D1 (`hitRateLimit` in `src/db.ts`), declared in
`src/limits.ts` (`LIMITS`) unless the "Where" column says otherwise. A "source"
is `CF-Connecting-IP`, which Cloudflare's edge sets and a client cannot; an
IPv6 address is cut to its /64. `X-Forwarded-For` and every other header are
ignored. Windows are in seconds.

## Auth levels

- **None**: no credential. Anybody on the internet.
- **Bearer (invalid)**: a device bearer that resolves to nothing. Same as None.
- **Session**: a signed browser cookie. Any Google account holder can get one,
  so this is semi-authenticated.
- **Device**: a valid device bearer, minted by the device flow.
- **Panel cookie / ticket**: the panel host's own credentials.
- **Signature**: proves itself with a signature (Stripe).

## The layers

1. **Bad bearer**, per source, `badToken` 600/600. Counts failures only, so a
   valid token is never refused. Stops unbounded token-lookup guessing.
2. **Signed-in floor**, `deviceRequests` 600/60 per device and
   `sessionRequests` 1200/600 per account, applied to every route in
   `src/index.ts` after authentication. A route added later is covered before
   anyone gives it a limit of its own. `/p/` is exempt from the session floor
   (it has `relayView`).
3. **Route limits**, below, tighter and keyed to what the route costs.

## Routes

| Route | Auth | Limit | Where | Note |
|---|---|---|---|---|
| `GET /healthz`, `/privacy`, `/terms`, unknown paths | None | none | n/a | Static text, no database or upstream work. Cloudflare's edge absorbs volume. |
| `GET /` | None or Session | signed-in floor | index.ts | Signed out it is a static page. |
| `GET /me` | Session or Device | signed-in floor | index.ts | |
| `POST /device/revoke` | Device | device floor | index.ts | |
| `GET /login` | None | `login` 600/600 per source | google.ts | Sized for a lecture hall behind one NAT. |
| `GET /oauth2/callback` | None (signed flow cookie) | `callback` 600/600 per source | google.ts | Checked before Google's token endpoint is called. Also serves the Drive connect return. |
| `GET/POST /logout` | None | none | n/a | Clears a cookie; no database or upstream work. |
| `POST /device/start` | None | `deviceStart` 600/600 per source, plus a global cap of 500 pending codes | devices.ts | |
| `POST /device/poll` | None (device code) | `devicePoll` 1200/60 per source | devices.ts | Answers `slow_down`, never 429 (RFC 8628). Device codes are 32 random characters. |
| `GET /device` | Session | with `?code=`: `deviceLookup` 60/600 per account and `deviceLookupAddress` 600/600 per source; plus session floor | devices.ts | |
| `POST /device/approve` | Session (browser only) | `deviceApprove` 30/600 per account and `deviceApproveAddress` 300/600 per source; plus session floor | devices.ts | The guess-a-code defense. |
| `POST /devices/:id/revoke`, `/devices/revoke-all` | Session (browser only) | session floor | index.ts | |
| `GET/POST /account/delete` | Session (browser only, recent sign-in) | POST: `accountDelete` 5/600 per account; plus session floor | account.ts | Counted after the sign-in and same-origin checks, before Stripe is called. |
| `POST /billing/checkout`, `/portal`, `/topup` | Session (browser only) | `billing` 20/600 per account | billing.ts | |
| `GET /drive/connect` | Session (browser only) | session floor | index.ts | Sets a cookie and redirects; no upstream call. |
| `POST /drive/disconnect` | Session (browser only) | session floor | index.ts | One call to Google's revoke endpoint. |
| `GET /drive/status` | Session or Device | signed-in floor | index.ts | |
| `POST /drive/token` | Device | `driveToken` 60/600 per account; plus device floor | drive.ts | Each call is a Google refresh. Counted before the grant is read. |
| `GET /settings/:name` | Device | device floor | index.ts | |
| `PUT /settings/:name` | Device | `settingsWrite` 120/600 per account; plus device floor | settings.ts | |
| `POST /proxy/transcribe` | Device | 20/window per account (`RATE_LIMITS`), plus monthly and global spend ceilings; plus device floor | proxy.ts | Pre-existing. |
| `POST /proxy/summarize` | Device | 5/window per account, same ceilings; plus device floor | proxy.ts | Pre-existing. |
| `POST /proxy/assistant` | Device | 10/window per account, same ceilings; plus device floor | assistant.ts | Pre-existing. |
| `GET /proxy/usage` | Session or Device | signed-in floor | index.ts | Reads only. |
| `GET /relay/connect` | Device | `relayConnect` 120/600 per device; plus device floor | relay.ts | Counted before the Durable Object is woken. |
| `ANY /p/:device/*` on the account host | Session | `relayView` 1200/600 per account (shared with the panel host) | relay.ts | Counted before the ownership lookup. Unsigned requests are refused before any database work. |
| `ANY /p/:device/*` on the panel host | Panel cookie | `relayView`, same bucket | panel-host.ts | Counted after the cookie is verified. A forged cookie fails an HMAC and costs no database work. |
| `GET /p/:device/_auth?t=` on the panel host (the ticket exchange) | Signed ticket | `panelTicket` 600/600 per source | panel-host.ts | Counted before the ticket is read. Tickets are single-use and expire in a minute. |
| `POST /stripe/webhook` | Signature | `stripeWebhook` 300/60 per source | stripe.ts | Counted before the body is read or the signature is checked. Requests with no signature header or no configured secret are refused first, at no cost. |

There is no `/panel/exchange` route; the ticket exchange is the `_auth`
segment above.

## Known limits of this scheme

- **The source address is weak.** A campus shares one; an attacker with an
  IPv6 /48 or many IPv4 addresses gets many buckets. Per-address limits are
  sized to stop one script, not a botnet. The per-account, per-device, global
  and money ceilings do not depend on the address.
- **Fixed windows** let through up to twice the limit across a boundary.
- **Unauthenticated static routes have no limit of their own.** They do no
  database or upstream work. A Cloudflare WAF rate-limiting rule on the zone
  would add a layer in front of everything, including these; it is not
  configured from this repo.
- **Counting is a D1 write per request** on signed-in routes. That is the
  cost of a limit that works across isolates.
- The Durable Object relay has its own body and response size caps
  (`panel-relay.ts`) but no request-rate limit of its own; `relayView` and
  `relayConnect` are the rate guards in front of it.
