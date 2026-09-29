# Rotating DRIVE_KEY

`DRIVE_KEY` seals every stored Google Drive refresh token (`drive_grants`).
Replacing it outright makes every grant unreadable and everyone reconnects
Drive. This procedure replaces it with nobody noticing.

Reviewed against the code and tests on 2026-09-29 for the 0.6.0 security bar
(HOME-STRETCH item 6). Every step below is either exercised by
`test/security.test.ts` ("rotating DRIVE_KEY") and
`test/threat-model-claims.test.ts` ("the DRIVE_KEY runbook"), or says that it
is not. What the code cannot do is said in "What this does not do" and in
"When the key leaked".

## How it works

- A sealed value is `<iv>.<box>.<key id>` (`src/crypto.ts`). The key id is 8
  hex characters derived from the key, so each row says which key opens it.
  Rows written before key ids existed are `<iv>.<box>` and still open.
- While `DRIVE_KEY_PREVIOUS` is set, a grant sealed under it still opens
  (`unseal` in `src/drive-keys.ts`), and the first time it is opened (a Mac
  asking `/drive/token`, or a disconnect) it is sealed again under
  `DRIVE_KEY`. The rewrite only replaces a row that still holds what was read,
  so a grant reconnected in the meantime is never overwritten.
- An hourly cron (`17 * * * *` in `wrangler.jsonc`, the `scheduled` handler in
  `src/index.ts`) does the same for grants nobody is using, and logs how many
  are left: `drive keys: resealed N, unreadable U, R not yet under the current
  DRIVE_KEY`. **A run handles at most 500 grants** (`sweepDriveGrants`,
  `maxRows`), so a table larger than that takes one hourly run per 500. It
  logs nothing once every grant is under the current key.
- The key id is only a hint. A wrong or edited one still has to pass AES-GCM
  (`test/attacks.test.ts`, "a sealed Drive grant cannot be bent by editing its
  key id").
- Nothing about Google changes. The refresh tokens themselves are the same
  before and after; only the key that wraps them changes.

## Before you start

1. **You need the current value of `DRIVE_KEY`.** Cloudflare will not show a
   secret's value, and nothing in this repo can recover it. If nobody has it,
   stop: without it, changing the key makes every grant unreadable, and the
   only way back is for each person to reconnect Drive from the account page.
2. Confirm no rotation is already under way. From any checkout, logged in to
   the Cloudflare account (set `CLOUDFLARE_ACCOUNT_ID=896f047d297ba60187557f9029f6fbc5`
   if you have more than one; it is the id pinned in `wrangler.jsonc`):

   ```bash
   npx wrangler secret list
   ```

   `DRIVE_KEY_PREVIOUS` should not be in the list. If it is, a rotation was
   started and not finished; finish it (steps 4 and 5) before starting another,
   or the older key is thrown away while grants are still sealed under it.
3. Pick a time when you can watch the logs for an hour. Nothing is
   user-visible, but the check in step 4 needs the cron to have run.

## Procedure

1. **Make the new key**, and keep it out of shell history and out of files:

   ```bash
   openssl rand -base64 48
   ```

   The code accepts any string and hashes it once with SHA-256 (`key()` in
   `src/crypto.ts`), so the strength is entirely the operator's job. Use at
   least 32 random bytes; never a phrase.

2. **Retire the current key first.** Put the CURRENT value of `DRIVE_KEY` into
   `DRIVE_KEY_PREVIOUS`. Nothing changes yet, because both names hold the same
   key. Each `secret put` makes a new deployment of the Worker; it takes
   effect within seconds and needs no code deploy.

   ```bash
   read -s OLD                                          # paste the current DRIVE_KEY
   printf %s "$OLD" | npx wrangler secret put DRIVE_KEY_PREVIOUS
   unset OLD
   ```

3. **Install the new key.**

   ```bash
   read -s NEW                                          # paste the new key
   printf %s "$NEW" | npx wrangler secret put DRIVE_KEY
   unset NEW
   ```

   From this moment new grants are sealed under the new key and old ones
   still open. **Do these two in this order.** Replacing `DRIVE_KEY` while
   `DRIVE_KEY_PREVIOUS` is unset makes every grant unreadable at once:
   `/drive/token` answers `grant_unreadable` (500) for everyone
   (`src/drive.ts`, the catch around `openGrant`), and no Mac can get a Drive
   access token from the account until it is fixed. Nothing is rewritten in that state, so putting the old key back
   as `DRIVE_KEY` undoes it completely (`test/threat-model-claims.test.ts`,
   "strands nothing, and rewrites nothing").

4. **Wait for the sweep, and check it.** The next hourly run (minute 17)
   reseals up to 500 grants; a Mac asking for a Drive token reseals its own
   sooner. There is no way to trigger the cron in production from here; it
   runs on the schedule. Confirm with either:

   - the logs (Workers Observability, or `npx wrangler tail`) at minute 17,
     where the `drive keys:` line should show `0 not yet under the current
     DRIVE_KEY`, or no line at all; or
   - the database, counting rows not under the new key:

     ```bash
     read -s KEY    # paste the new key
     KID=$(printf 'syllabus-drive-key-id:%s' "$KEY" | shasum -a 256 | cut -c1-8); unset KEY
     npx wrangler d1 execute syllabus-accounts --remote \
       --command "SELECT COUNT(*) AS n FROM drive_grants WHERE refresh_token_enc NOT LIKE '%.$KID'"
     ```

     The key id is computed the way `keyId()` computes it; a test pins the
     shell recipe to the code (`printf ... new-key` gives `c8cc8b7f`).

   Then prove a real grant opens under the new key, without printing a token.
   From a Mac that has a device token (`TOKEN` is that Mac's `syd_...` token):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     https://syllabusaccounts.maincoursemedia.com/drive/token \
     -H "Authorization: Bearer $TOKEN"
   ```

   `200` means the grant opened. `404` means that account has no grant, and
   `409` means Google no longer honors it; neither is a rotation problem.
   `500` with `grant_unreadable` is: stop and see "Rollback".

   `unreadable` above zero in the log means some grants open under neither key.
   They were already broken before this rotation (sealed under a key that is
   already gone); their owners reconnect Drive from the account page, and the
   count does not block the next step. Note that `remaining` counts them too,
   so with any unreadable grant the log line never goes quiet.

5. **Delete the previous key** once the count is zero, or only unreadable
   grants remain:

   ```bash
   npx wrangler secret delete DRIVE_KEY_PREVIOUS
   ```

   From here a grant still sealed under the old key is unreadable for good.

6. Store the new key wherever the operators keep secrets. Keep the old one
   for now too (see "Backups and restores"); destroy it later, not today.

Rolling the Worker back to code from before this procedure existed is safe:
older code reads the first two parts of a sealed value and ignores the key
id, so every grant sealed under the key it knows still opens.

## Rollback

- **Before step 5,** swap the two secrets. Put the new key into
  `DRIVE_KEY_PREVIOUS` and the old key into `DRIVE_KEY`. Grants already
  resealed under the new key open as "previous" and are sealed again under the
  old key on use and by the sweep. This works even after the sweep has moved
  every row (`test/threat-model-claims.test.ts`, "rolls back by swapping").
- **After step 5,** if you still have the old key, set it as
  `DRIVE_KEY_PREVIOUS` again. Grants not yet resealed open again, and the sweep
  finishes the job. If you do not have it, those grants are gone and their
  owners reconnect.
- **If `grant_unreadable` appears right after step 3,** you skipped step 2 or
  pasted a wrong key. Put the old key back as `DRIVE_KEY`; nothing was rewritten.

## Backups and restores

The rotation reseals the live table. It cannot reach copies of the table made
earlier, and this is where a retired key still matters:

- **D1 Time Travel** can restore the database to a point before the sweep.
  Restored rows are sealed under the OLD key. If `DRIVE_KEY_PREVIOUS` was
  already deleted, they are unreadable until you set the old key back as
  `DRIVE_KEY_PREVIOUS`. So: after any restore, re-add the old key first. The
  retention window is set by the Cloudflare plan (check the dashboard), and
  the old key has to outlive it.
- **Exports and backups** taken before the rotation still open with the old
  key. A rotation done because the old key leaked does not protect data that
  already left in a backup; see below.

## What this does not do

- It does not change any Google refresh token. Someone who obtained a
  decrypted refresh token before the rotation still has a working token.
- It does not enforce key strength or age. `DRIVE_KEY` has no expiry, and the
  code will start with any string, even a short one. A guard that refuses a
  key under 32 characters would be a one-line change in `src/crypto.ts`;
  it is not made here, because refusing to start a Worker over a secret needs
  a decision about what to do to keys already in use.
- It does not rotate `SESSION_SECRET`, which is a separate act with its own
  side effects: it signs everyone out, invalidates panel tickets and cookies,
  and also breaks the repeat-trial block, because that hash is keyed from it
  (`trialHash` in `src/crypto.ts`).

## When the key leaked

Rotating protects the grants from the old key from now on. It does not undo
a leak that already happened:

- **Only the key leaked** (for example a `.dev.vars` file): rotate as above.
  The refresh tokens were never exposed, because they are not readable
  without the database.
- **The key and the database both leaked** (or the key and any backup or
  export of `drive_grants`): treat every refresh token as stolen. A refresh
  token lets its holder mint Drive access tokens for the files Syllabus created
  in that person's Drive, which is where the lecture summaries and transcripts
  live. Rotate first, so the live table stops being readable with the leaked
  key, and then end the grants at Google. **The code cannot do the second part
  in bulk.** `revokeGrantAtGoogle` (`src/drive.ts`, a `POST` to
  `https://oauth2.googleapis.com/revoke`) is reached only from a person's own
  Disconnect and from account deletion, and there is no operator route or
  script. The options, in order of cost:
  1. **Each person disconnects** from the account page, or removes Syllabus
     at `myaccount.google.com/permissions`. Slow, and needs telling everyone
     why. Fine for a few accounts.
  2. **An operator script.** Read `refresh_token_enc` for every row, open each
     with the old key (`unseal` in `src/drive-keys.ts`), and POST each
     plain token to Google's revoke endpoint, then delete the row. It is about
     thirty lines built from `unseal` and `revokeGrantAtGoogle`, and it is not
     in the repo. **Write and test it before launch, not during an incident.**
     It has to be run by someone who still holds the leaked key, which is why
     you keep the key until it is done.
  3. **Delete the OAuth Web client** in Google Cloud project
     `friendly-bazaar-507320-b7`, which stops the tokens issued to it (confirm
     against Google's documentation before relying on this). It also breaks
     sign-in for everyone until a new client id and secret are in place
     (`GOOGLE_CLIENT_ID` in `wrangler.jsonc`, the `GOOGLE_CLIENT_SECRET`
     secret). The Desktop client that Syllabus ships is a separate client and
     is not affected. This is the last resort.

  After the tokens are dead, remove the ciphertext and tell people to
  reconnect:

  ```bash
  npx wrangler d1 execute syllabus-accounts --remote --command "DELETE FROM drive_grants"
  ```

  Afterwards every account page shows Drive as not connected and every Mac
  gets `404 no_grant` from `/drive/token` until its owner connects again.
  Tell them why.
