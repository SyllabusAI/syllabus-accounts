# Switching Stripe from the sandbox to live mode

Everything in billing was built and tested against a Stripe **sandbox**. Live
mode shares nothing with it: its own products, prices, keys, webhook
endpoints, portal settings, coupons and tax settings. This is the whole
switch, in order. Once the dashboard work is done, the code side is pasting
four price ids into one command and merging the PR it produces.

The short version:

1. Do the dashboard checklist below, in live mode.
2. `STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-live.mjs --dry-run --starter price_... --standard price_... --pro price_... --topup price_...`
3. The same command without `--dry-run`, then a PR with `wrangler.jsonc` and `worker-configuration.d.ts`. Merging it deploys.
4. `npx wrangler secret put` the three live secrets the script prints.
5. Check one real purchase end to end.

Nothing here is run by CI or by the deploy. `deploy.yml` never touches Worker
secrets, and the script only reads from Stripe.

## 1. Dashboard checklist (live mode)

Switch the dashboard out of the sandbox first (the account picker, top left)
and check the header no longer says "Sandbox" or "Test mode" on every page
below. Settings made in the sandbox do not carry over.

### Activate the account

Settings > Business: entity details for Main Course Media LLC, EIN, the bank
account payouts go to, and identity verification for the representative.
This is the slow part and blocks everything else in live mode.

### Products and prices

Four products, each with one price. The amounts must be exactly what
`src/tiers.ts` sells; the script refuses anything else.

| Product | Price | Type | Tax behavior |
| --- | --- | --- | --- |
| Syllabus Starter | $9.00 USD | Recurring, monthly (every 1 month), flat rate | Exclusive |
| Syllabus Standard | $15.00 USD | Recurring, monthly, flat rate | Exclusive |
| Syllabus Pro | $25.00 USD | Recurring, monthly, flat rate | Exclusive |
| Syllabus extra hours (5 hours) | $5.00 USD | **One-time** | Exclusive |

- **Tax behavior exclusive**, because the terms say the price is "plus any
  sales tax". The script refuses an inclusive price and warns on an
  unspecified one.
- **Tax code on each product**: Software as a service (SaaS), personal use
  (`txcd_10103000`). Pick it from the product's tax category list and confirm
  the name there, since that list is the authority. The script warns when a
  product has no tax code.
- **Do not put a trial on the price.** The 90-day trial is set per Checkout
  session by the code (`TRIAL_PERIOD_DAYS` in `src/tiers.ts`), and only for
  somebody who has never had a trial.
- Copy the four `price_...` ids (not the `prod_...` ids). Those are what the
  script takes.

Getting a pair swapped is the dangerous mistake: it grants the wrong plan at
the right price and nothing notices. The script checks each id against its
amount, so a swap is refused rather than deployed.

### Stripe Tax, with the Texas registration

Every Checkout this service creates has `automatic_tax: { enabled: true }`,
so a Checkout fails to start in live mode until Stripe Tax is set up there.

1. Tax > Settings: turn Stripe Tax on. Head office (origin) address:
   5900 Balcones Drive, Suite 100, Austin, TX 78731.
2. Default tax behavior: exclusive. Default product tax code: SaaS, personal
   use, as above (a fallback for any product missing its own).
3. Tax > Registrations > Add registration: United States, Texas, with the
   Texas sales and use tax permit (Comptroller taxpayer number) and its
   effective date. Texas taxes this as a data processing service, which is
   why the code requires a billing address at Checkout.
4. Add any other state as its economic nexus threshold is reached; Tax >
   Registrations shows the thresholds being approached.

### The 100%-off promotion code (friends and family)

The "I have a code" path on the account page opens Checkout with
`allow_promotion_codes: true` and no card collected unless one is required,
so the code alone is what makes it free.

1. Product catalog > Coupons > New: **100% off**, duration **Forever**,
   applies to the Starter, Standard and Pro products (not the extra hours
   product).
2. On that coupon, create a **promotion code** with the customer-facing code
   the sandbox used (or a new one). Set a **maximum number of redemptions**
   and an **expiry date**: anyone who learns the code gets a free
   subscription with no card (threat model 0.6, F-10b).
3. Leave "First-time order only" off, so somebody who once paid can still
   redeem it.

### Customer portal

`/billing/portal` opens Stripe's portal for any account that has a Stripe
customer. It fails ("Stripe could not open the billing page") until the live
portal configuration is saved once. Settings > Billing > Customer portal:

- **Cancellations: on, "At the end of the billing period".** The terms
  promise that somebody who cancels keeps their hours until the end of the
  month they paid for and is not charged again. Canceling immediately would
  cut them off early. **No proration or refund on cancel**: the terms say
  canceling does not refund the current month. (Refunds for deleted accounts
  are the code's job, `endSubscription` in `src/stripe.ts`.)
- **Subscription changes (switch plans): if turned on, list only the Starter,
  Standard and Pro live prices.** The webhook maps a price id to a tier; a
  price it does not know is granted Starter and logged, whatever was paid.
- **Pause subscriptions: off.** The webhook handles `paused` (it stops
  entitling) but nothing on the account page explains a paused plan.
- **Payment methods: on**, so an expired card can be replaced while Stripe
  retries (`past_due` keeps entitling for that window).
- **Customer information: allow updating the billing address** (tax is
  worked out from it). Email and name as you prefer.
- **Invoice history: on.**
- Business information: the terms and privacy links,
  `https://syllabusaccounts.maincoursemedia.com/terms` and `/privacy`.
- The return link is sent by the code on every session, so no default
  redirect is needed.

### Checkout settings

- Settings > Payments > Payment methods: **cards (and wallets) only.** A
  top-up is granted on `checkout.session.completed` only when the session is
  already `paid`; the webhook does not listen for
  `checkout.session.async_payment_succeeded`, so a bank debit or other
  delayed method would take the money and never grant the hours.
- Settings > Checkout and Payment Links: the business name and branding
  customers will see.

### The webhook endpoint

Developers > Webhooks > Add endpoint (in live mode):

- **URL:** `https://syllabusaccounts.maincoursemedia.com/stripe/webhook`
- **Events** (exactly the `HANDLED` set in `src/stripe.ts`; the script prints
  them from the code, so trust its output if this list and the code ever
  disagree):
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.paused`
  - `customer.subscription.resumed`
- Events not in that list are answered 200 and ignored, so subscribing to
  more costs nothing but noise.
- Reveal the endpoint's **signing secret** (`whsec_...`). That becomes
  `STRIPE_WEBHOOK_SECRET`. A secret from the sandbox endpoint fails every
  live delivery as a bad signature, which looks like an attack in the log.

### Keys

- **Secret key** (Developers > API keys, `sk_live_...`): becomes
  `STRIPE_SECRET_KEY`. Checkout, the Billing Portal, ending a spent trial and
  listing a deleted account's subscriptions spend it.
- **Restricted key for account deletion** (Developers > API keys > Create
  restricted key, `rk_live_...`): becomes `STRIPE_ACCOUNT_DELETION_KEY`. Per
  `src/env.ts` it is restricted to:

  | Resource | Permission | Used for |
  | --- | --- | --- |
  | Subscriptions | Write | canceling the subscription of a deleted account (`subscriptions.cancel`) |
  | Refunds | Write | refunding the unused time, and a top-up paid after deletion (`refunds.create`) |
  | Customers | Write | deleting the customer, which removes the saved card (`customers.del`) |
  | Invoices | **Read** | see below |
  | Everything else | None | |

  **Invoices: Read is not in the list in `src/env.ts`, and probably has to
  be.** `endSubscription` cancels with `expand: ["latest_invoice"]` and then
  calls `invoicePayments.list` on that invoice to find the charge to refund,
  both through this key. A restricted key without read access to invoices is
  likely to have one or both of those refused. If the cancel itself is
  refused, account deletion stops before deleting anything; if only the
  refund is, the log says `REFUND OWED` and it has to be issued by hand.
  Before launch, create the same restricted key in the sandbox, set it
  locally, and delete a test account holding a paid subscription to confirm
  exactly which permissions are needed.

  Unset, this key falls back to `STRIPE_SECRET_KEY`, so the switch works
  without it; it only narrows what a leak of the main key can do.

- The script itself needs a live key that can **read Prices and Products**.
  The live secret key works. A restricted key with just those two on Read is
  better if you would rather not paste the full key into a terminal.

## 2. Run the script

From a fresh branch off `main`:

```sh
git checkout main && git pull --ff-only
git checkout -b <you>/stripe-live

# Dry run: reads the four prices from Stripe, checks them, writes nothing.
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-live.mjs --dry-run \
  --starter price_... --standard price_... --pro price_... --topup price_...
```

Or put the ids in a file (it holds only public price ids, but keep it out of
the commit):

```json
{ "starter": "price_...", "standard": "price_...", "pro": "price_...", "topup": "price_..." }
```

```sh
STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-live.mjs --dry-run --ids live-prices.json
```

A leading space before the command keeps the key out of zsh history when
`HIST_IGNORE_SPACE` is set; `read -s STRIPE_SECRET_KEY && export
STRIPE_SECRET_KEY` avoids typing it on the command line at all.

For each price it checks: live mode, active, on an active product, USD, a
flat per-unit amount equal to `src/tiers.ts` ($9, $15, $25 monthly, every
1 month; $5 one-time for the top-up), and tax behavior. It also refuses a
test key, a publishable key, a `prod_` id where a `price_` id belongs, and
the same id in two slots. Any error means nothing is written.

When the dry run is clean, run it again without `--dry-run`. It then:

- rewrites the four `STRIPE_PRICE_*` vars in `wrangler.jsonc`, leaving every
  comment and every other line alone, and
- regenerates `worker-configuration.d.ts`, which carries each var as a
  literal type. CI fails a PR whose copy is stale. The script generates it in
  a scratch copy of the project so a local `.dev.vars` does not leak its
  secret names into it; if `npm run typecheck` later adds
  `GOOGLE_CLIENT_SECRET` and friends to that file, that is `.dev.vars`, and
  `git checkout worker-configuration.d.ts` after the run puts it back.

It prints, and does not run, the `wrangler secret put` commands and the
webhook URL and events.

## 3. Deploy by merging

```sh
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "Stripe: live price ids"
git push -u origin <you>/stripe-live
gh pr create --fill
gh pr merge --squash --delete-branch   # once CI is green
gh run list --workflow Deploy --limit 1
```

The merge deploys. Do not `npm run deploy` by hand.

## 4. Set the live secrets

Right after the Deploy run is green, from the repo:

```sh
npx wrangler secret put STRIPE_SECRET_KEY            # sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET        # whsec_... of the LIVE endpoint
npx wrangler secret put STRIPE_ACCOUNT_DELETION_KEY  # rk_live_...
```

Each prompts for the value and takes effect as soon as it is saved.

Between the deploy and the last of these there is a short window where the
prices are live and the key is still the sandbox one (or the other way
round, if the secrets go first). Checkout fails in that window with "Stripe
could not start that. Nothing was charged." and no money moves, so do the
two back to back rather than worrying about the order. Live webhook
deliveries that arrive before `STRIPE_WEBHOOK_SECRET` is set are refused and
retried by Stripe for about three days, so none are lost.

## 5. Check it

- The account page shows the three plans, and a capped account now shows
  "Add 5 hours for $5" (it is hidden while `STRIPE_PRICE_TOPUP` is empty).
- Buy Starter with the promotion code: Checkout should ask for an address
  and no card. Then Developers > Webhooks > the live endpoint should show the
  deliveries answered 200, and the account page should show Starter.
- Buy one plan with a real card, check the tax line on the Texas address,
  open Manage billing, cancel, and refund the charge from the dashboard.
- `npx wrangler tail` while doing it shows `stripe:` lines for each event.
- Any subscription rows left in D1 from sandbox testing point at sandbox
  ids the live key cannot see. They keep entitling until their period end
  plus the three-day grace, and any Stripe call about them answers "no such
  subscription", which the code treats as already ended.

## Going back to the sandbox

Revert the PR (a new PR that restores the sandbox ids; the merge deploys)
and `wrangler secret put` the three sandbox secrets again.
