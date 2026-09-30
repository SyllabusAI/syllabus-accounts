# Ending every credential at once (bulk revoke)

For the day the runbook's "key and database both leaked" branch
([drive-key-rotation.md](drive-key-rotation.md), "When the key leaked") is real:
the encrypted Drive grants and the key that opens them are both out, and every
device token, browser session and Drive refresh token has to be treated as
stolen. `scripts/bulk-revoke.mjs` does all of it, for every account or a chosen
few, and can be stopped and resumed.

It was built and tested before launch so nobody writes it during an incident
(threat model F-08). It has only ever run against the test database, with a
stand-in for Google. **Rehearse the dry run against production** (below) before
you need it.

## What it does to each account

| Step | What | How |
| --- | --- | --- |
| tokens | Every device token, every panel cookie, every panel ticket | `token_version + 1`; every device token and device marked revoked. The same three writes as "Sign out everywhere" (`revokeEverything`, `src/db.ts`). Panel cookies are bound to `token_version`; a ticket already minted dies with its device, because the panel host refuses a revoked device |
| sessions | Every browser session cookie | `session_version + 1`, only when `accounts` has that column (migration 0017, PR #52). Detected on every run with `PRAGMA table_info(accounts)`, so the tool works before and after #52 lands |
| grant | The Drive refresh token | Opened with `DRIVE_KEY`, then `DRIVE_KEY_PREVIOUS` (as `unseal` in `src/drive-keys.ts`), revoked at Google, and only then is the stored ciphertext deleted |

Things it deliberately does not do:

- **It does not touch `panel_tickets`.** That table holds the nonces of tickets
  already spent; deleting rows would make a spent ticket usable again.
- **It never seals a grant again.** The Worker reseals when it opens a grant;
  this tool only reads, so a run leaves nothing behind under any key.
- **It does not rotate `DRIVE_KEY` or `SESSION_SECRET`.** Rotate first
  (the runbook), then run this. If `session_version` does not exist yet,
  browser sessions are not ended by the tool; rotating `SESSION_SECRET` signs
  everyone out and is the only other way.
- A grant that neither key opens is reported as `unreadable` and its row is
  kept. It was already unusable to this service; if the leaked key is the one
  that opens it, run again with that key as `DRIVE_KEY_PREVIOUS`.

## Why a script, and why here

A Worker endpoint that revokes everything would be a new door into the account
system, guarded by one more secret, and it would need the same `DRIVE_KEY` the
Worker holds. A script run by an operator adds no attack surface to production:

- The database is reached through Cloudflare's D1 HTTP API with an operator's
  API token (`CLOUDFLARE_API_TOKEN`), so nothing is deployed and nothing new is
  exposed. Parameters are bound, never spliced into SQL.
- `DRIVE_KEY` (and `DRIVE_KEY_PREVIOUS`) come **only from the environment**,
  never from a flag, a file or history. The Google call has to be made by
  someone who holds the key, because the refresh token exists in plain text only
  after opening it; a script on the operator's machine does that and posts the
  token to `https://oauth2.googleapis.com/revoke` directly. The Worker is not
  involved.
- Off the Worker there is no 50-subrequest cap and no CPU limit to design
  around, which a loop of one Google call per grant would otherwise hit. The
  only limits left are D1's 100 bound parameters per statement (so batches are at
  most 90 accounts, default 50) and Google's tolerance (default 5 calls a
  second, with three tries and backoff on 429 and 5xx).

## Running it

You need Node 20 or newer, a checkout of this repo at a commit that has the
script, a Cloudflare API token that can edit D1 on this account, and the
Drive key. Run it from a laptop or the VPS with the secrets injected by
Infisical, so that none of them touches disk or shell history:

```bash
# 1. Dry run. The default. Changes nothing, writes nothing, calls nobody.
infisical run --env=prod -- node scripts/bulk-revoke.mjs

# 2. For real. Asks for a typed confirmation first.
infisical run --env=prod -- node scripts/bulk-revoke.mjs --execute
```

The dry run prints how many accounts, live devices and live tokens are in scope,
how many Drive grants there are and **how many open with the key you gave**. If
that last number is not "all of them", stop and fix the key before executing.
It also says whether `session_version` was found.

`--execute` prints the same summary, then asks you to type exactly
`REVOKE <n> ACCOUNTS`, with `n` the number in scope. Anything else aborts with
nothing changed.

Options (all after the script name):

| Flag | Meaning |
| --- | --- |
| `--only id1,id2` | Only these accounts. Unknown ids are listed and ignored |
| `--run-id NAME` | Name the run, or resume one. Default: a new id, printed at the start |
| `--skip-drive` | Leave Drive grants alone (then `DRIVE_KEY` is not needed) |
| `--batch N` | Accounts per batch, 1 to 90, default 50 |
| `--per-second N` | Google revoke calls a second, default 5 |
| `--out-dir DIR` | Where the audit log goes, default the current directory |

Environment: `CLOUDFLARE_API_TOKEN`, `DRIVE_KEY`, optionally
`DRIVE_KEY_PREVIOUS`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` (the last two
default to `wrangler.jsonc`). `DRIVE_KEY` has to be the value the grants are
sealed under, which Cloudflare will not show you; keep it in Infisical.

## Stopping, failing, and finishing

The audit log `bulk-revoke-<run-id>.jsonl` is also the run's memory. Each line
is one finished step for one account: account id, step, ok or not, and a short
code (`none`, `revoked`, `already_invalid`, `unreadable`, `google_503`,
`network`, and so on). It never holds an email, a name, a token, a refresh
token or a key. It is created with mode 600 and is git-ignored; keep it with the
incident notes.

- **Interrupted** (laptop closed, D1 unreachable): run the same command with
  `--run-id <the id it printed>`. Steps already recorded are skipped, so nobody
  is signed out twice and Google is not asked twice.
- **Google failures** do not stop the run. The account's other steps finish, the
  grant stays stored, the failure is recorded and listed at the end, and the
  exit code is 2. Run again with the same `--run-id` once Google is healthy and
  only those grants are retried.
- **A new `--run-id` is a new incident.** It bumps every version again, which
  signs people out again. Use the same id to finish, a new one to start over.
- **After PR #52 deploys**, to finish a run that happened before it: run again
  with the same `--run-id`. The tokens are not touched again; only the sessions
  step is done.
- People can reconnect Drive while a run is going. The tool only deletes the row
  it read, so a fresh connection is kept, but Google revokes by grant, so
  revoking an old token can also end a newer one for the same person. They
  reconnect from the account page.

## Order of an incident

1. Rotate `DRIVE_KEY` as in the runbook, keeping the old value as
   `DRIVE_KEY_PREVIOUS`. (Or skip rotation and give this tool the leaked key as
   `DRIVE_KEY`; either way it must hold the key that opens the grants.)
2. Dry run. Check "open with the keys given".
3. `--execute`. Watch for failures; resume until there are none.
4. If it said `session_version` was missing, rotate `SESSION_SECRET` or ship
   migration 0017 and resume.
5. Tell people why they are signed out and must reconnect Drive.

## What has not been checked

Google's behavior. The tests use a stand-in for the revoke endpoint. The tool
relies on the documented behavior of `https://oauth2.googleapis.com/revoke`: 200
when the token is revoked, 400 `invalid_token` when it is not (or no longer)
valid. The first time this runs for real, on one test account with `--only`, look
at the summary and at `myaccount.google.com/permissions` for that account.
