-- One free trial per card, as the terms say ("One trial per person"), so a
-- single card cannot start a trial on every Google account it can make (F-10).
--
-- A row is a keyed hash of the card's Stripe fingerprint (trialHash in
-- src/crypto.ts, under TRIAL_SECRET, with a "card:" label), never the
-- fingerprint, a card number, or anything else about the card. It names the
-- account whose trial the card started, so the same account's own later
-- events do not count against it, and it goes with that account when the
-- account is deleted. Nothing is written while TRIAL_CARD_CHECK is off.

CREATE TABLE trial_cards (
  card_hash   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);

CREATE INDEX trial_cards_account ON trial_cards (account_id);
