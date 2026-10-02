# Launch-week runbook

What to do when production is wrong. Each section says what to run and what
it costs. The commands run from this repo with `npx wrangler` signed in to
the Cloudflare account that owns the Worker. The backup and restore path
below was tested on 2026-10-02: a full export of production took 4 seconds
(68 KB), loaded into a local throwaway database, and matched production row
for row (5 accounts, 208 usage rows, 17 migrations).

## Is it broken?

- `curl -s https://syllabusaccounts.maincoursemedia.com/healthz` answers
  without touching the database or a provider. If it fails, the Worker or
  Cloudflare is down, not a provider.
- `npx wrangler tail --format pretty` streams live requests and every
  `log()` line, already scrubbed of emails, query strings and keys
  (`src/log.ts`). Workers Logs in the Cloudflare dashboard keeps them for
  later.
- A provider failure shows as `provider_busy` or `provider_unavailable`
  refusals in the tail, and the Mac keeps the recording in its inbox to
  retry. Check the provider's status page before touching this service.
- `npm run split` shows which provider transcription actually went to this
  month and what it cost.

## Roll back the Worker

Use this when a deploy broke something and the fix is not quick.

```bash
npx wrangler deployments list
npx wrangler rollback <version-id> -m "why"
```

- Rolls back code only. **Secrets and D1 are not rolled back.** A version
  that predates a migration still runs against the migrated schema, so
  check the migration before rolling back across one.
- The next merge to `main` deploys again and replaces the rollback. Revert
  the bad PR on `main` (through a PR) in the same hour, or the fix is undone
  by the next unrelated merge.
- Takes effect in seconds. Nobody is signed out.

## Restore the database

D1 Time Travel restores **in place**: it rewinds production to an earlier
moment and discards every write made since. That includes new sign-ups,
devices, usage rows, subscriptions and Stripe-linked rows. It keeps 30 days.
Use it only for data loss or corruption, never for a code bug (roll back
instead).

1. Take an export first, so the restore can be undone:

   ```bash
   npx wrangler d1 export syllabus-accounts --remote --output before-restore.sql
   ```

   The file holds personal data and sealed Drive grants. Keep it off shared
   drives and delete it when the incident is closed.

2. Find the restore point and restore:

   ```bash
   npx wrangler d1 time-travel info syllabus-accounts --timestamp 2026-10-12T15:00:00Z
   npx wrangler d1 time-travel restore syllabus-accounts --timestamp 2026-10-12T15:00:00Z
   ```

3. Repair what the rewind undid:
   - **Stripe.** Subscription changes after the restore point are gone from
     D1, while Stripe still has them. In the Stripe dashboard, resend the
     webhook events from the restore point onward (Developers, Webhooks, the
     endpoint, each event, Resend). The handler is idempotent on event id, so
     resending one that already applied is harmless. The hourly reconcile
     catches lost cancellations, not lost subscriptions.
   - **Devices and sessions.** Anyone who signed in or added a Mac after the
     restore point has to do it again. Nothing else breaks.
   - **Usage.** Usage after the restore point is forgotten, so allowances are
     briefly more generous than they should be.

## Backups beyond 30 days

Time Travel is the only backup, and it keeps 30 days. A by-hand export is
the longer one:

```bash
npx wrangler d1 export syllabus-accounts --remote --output syllabus-accounts-$(date +%F).sql
```

Whether to schedule it, and where the file may live given what it holds, is
an open decision for the owners.

## The monthly service cap

`GLOBAL_CEILING` in `src/proxy.ts` caps the whole service at 400 audio hours
and 12M summary tokens a calendar month, across every account. When it
trips, every Mac's transcription or summary is refused with
`service_ceiling` (HTTP 402), the recording stays in the Mac's inbox, and
the assistant says it is paused for everyone.

- **Where it stands.** This month's totals, read only:

  ```bash
  npx wrangler d1 execute syllabus-accounts --remote --command "SELECT kind, SUM(units) AS units, COUNT(DISTINCT account_id) AS accounts FROM usage WHERE period = strftime('%Y-%m','now') GROUP BY kind"
  ```

  Audio is in seconds (400 hours is 1,440,000). Summaries are in tokens.
- **Raising it.** Change the constant in a PR. The merge deploys it in a few
  minutes. Recordings held in inboxes are processed on the Mac's next run.
- **Sizing.** September ran about 26,000 summary tokens per audio hour, so
  12M tokens is about 470 audio hours. The two caps run out at about the
  same time.

## The hourly cron

`17 * * * *` in `wrangler.jsonc` runs three jobs:

- The Drive key re-seal (`sweepDriveGrants`), which is what finishes a
  `DRIVE_KEY` rotation.
- The rate-limit row cleanup.
- The Stripe reconcile for lost cancellations (`reconcileAllowances`).

It logs only when a job did something or failed. To see it run, start
`npx wrangler tail --format json` a minute before :17 and look for an event
with `"cron": "17 * * * *"`.
