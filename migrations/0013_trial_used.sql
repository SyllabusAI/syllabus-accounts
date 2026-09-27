-- Google identities whose free trial is spent, kept after their account is deleted.
--
-- Deleting an account deletes every row that names it (src/db.ts,
-- deleteAccountData), including the allowance row that said its trial was
-- over. Without something surviving the deletion, delete-and-sign-in-again
-- would be five free hours on demand, forever.
--
-- So one thing survives: a keyed one-way hash of the Google `sub`, and when it
-- was written. Never the sub itself and never the email. The hash is
-- HMAC-SHA256 under a key derived from SESSION_SECRET (src/crypto.ts,
-- trialHash), so this table alone cannot be turned back into an identity or
-- checked against a guessed one without the Worker's secret.
--
-- A new account whose sub hashes to a row here gets an allowance row of zeros
-- with source 'trial_used' at sign-in, instead of the trial that a missing
-- row means, and Checkout starts its subscription without a Stripe trial.
-- Paid plans work exactly as for anybody else.
--
-- Rotating SESSION_SECRET changes every hash, which forgets this table: the
-- people in it would get a trial again. That is the failure in the harmless
-- direction.
--
-- Stands alone: it touches no other table, so it applies cleanly whether it
-- lands before or after any other pending migration (wrangler applies each
-- unapplied file by name).

CREATE TABLE trial_used (
  sub_hash   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
