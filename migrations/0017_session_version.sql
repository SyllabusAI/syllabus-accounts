-- One number that invalidates every browser session an account ever had.
--
-- The session cookie is signed and holds nothing server-side, so until now a
-- stolen cookie stayed good for its 30 days and "Sign out every Mac" left
-- every browser signed in. The cookie now carries the account's
-- session_version, and a request whose cookie names an older one is signed
-- out. "Sign out every Mac" bumps it (revokeEverything in src/db.ts), in the
-- same statement that bumps token_version.
--
-- Cookies issued before this migration carry no version and count as 0, so
-- they keep working until the first bump.

ALTER TABLE accounts ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
