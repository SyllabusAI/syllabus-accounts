# Rotating DRIVE_KEY

`DRIVE_KEY` seals every stored Google Drive refresh token (`drive_grants`).
Replacing it outright makes every grant unreadable and everyone reconnects
Drive. This procedure replaces it with nobody noticing.

## How it works

- A sealed value is `<iv>.<box>.<key id>`. The key id is 8 hex characters
  derived from the key, so each row says which key opens it. Rows written
  before key ids existed are `<iv>.<box>` and still open.
- While `DRIVE_KEY_PREVIOUS` is set, a grant sealed under it still opens, and
  the first time it is opened (a Mac asking `/drive/token`, or a disconnect)
  it is sealed again under `DRIVE_KEY`.
- An hourly cron (`17 * * * *`, the scheduled handler in `src/index.ts`) does
  the same for grants nobody is using, and logs how many are left:
  `drive keys: resealed N, unreadable U, R not yet under the current DRIVE_KEY`.
  It logs nothing once every grant is under the current key.
- The rewrite only replaces a row that still holds what was read, so a grant
  reconnected in the meantime is never overwritten.

## Procedure

Run from any checkout with wrangler logged in to the Cloudflare account
(`CLOUDFLARE_ACCOUNT_ID=896f047d297ba60187557f9029f6fbc5` if more than one).

1. **Make the new key**, and keep it out of shell history:

   ```bash
   openssl rand -base64 48
   ```

2. **Retire the current key first.** Put the CURRENT value of `DRIVE_KEY` into
   `DRIVE_KEY_PREVIOUS`. Nothing changes yet, because both names hold the same
   key.

   ```bash
   npx wrangler secret put DRIVE_KEY_PREVIOUS    # paste the current DRIVE_KEY
   ```

   If nobody has the current value, stop: the procedure needs it, and
   without it every grant is already unreadable once the key changes.

3. **Install the new key.**

   ```bash
   npx wrangler secret put DRIVE_KEY             # paste the new key
   ```

   From this moment new grants are sealed under the new key and old ones
   still open.

4. **Wait for the sweep.** The next hourly run reseals every grant it can
   open. Confirm with either:

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

   `unreadable` above zero means some grants open under neither key. They
   were already broken before this rotation; their owners reconnect Drive
   from the account page, and the count does not block the next step.

5. **Delete the previous key** once the count is zero, or only unreadable
   grants remain:

   ```bash
   npx wrangler secret delete DRIVE_KEY_PREVIOUS
   ```

6. Store the new key wherever the operators keep secrets, and destroy copies
   of the old one.

Rolling the Worker back to code from before this procedure existed is safe:
older code reads the first two parts of a sealed value and ignores the key
id, so every grant sealed under the key it knows still opens.

## When the key leaked

Rotating protects the grants from the old key from now on. It does not undo
a leak that already happened:

- **Only the key leaked** (for example a `.dev.vars` file): rotate as above.
  The refresh tokens were never exposed, because they are not readable
  without the database.
- **The key and the database both leaked:** treat every refresh token as
  stolen. Rotate, then revoke each grant at Google and delete it, so every
  person reconnects Drive. Tell them why.
