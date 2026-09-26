-- A device token that nobody uses stops working.
--
-- Until now a syd_ token lived until somebody revoked it, so a Mac that was
-- lost, sold or thrown away kept a working credential forever unless its
-- owner remembered to remove it. A token is now good for 90 days after it
-- was last used, and every use slides that window forward (src/index.ts),
-- so a Mac in regular use is never signed out and an abandoned one is.
--
-- last_used_at is written at most once a day per token, not on every
-- request, to keep D1 writes off the hot path.
--
-- Every token live at deploy counts as used now, so nobody is signed out by
-- this migration. A token left NULL (one minted by the previous Worker in
-- the minute between this migration and the deploy) is read as "used now"
-- by the Worker and stamped on its first use, for the same reason.

ALTER TABLE device_tokens ADD COLUMN last_used_at TEXT;

UPDATE device_tokens
   SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE revoked_at IS NULL;
