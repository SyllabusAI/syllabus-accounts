-- Top-ups are not part of Syllabus (decided 2026-10-12). Running out of hours
-- is a hard stop until the month turns over or the plan is upgraded; nothing
-- extra is sold on top of a plan.
--
-- The table never held a row in production: STRIPE_PRICE_TOPUP was never
-- set there, so /billing/topup refused before reaching Stripe. Checked with
-- a COUNT(*) against the remote database before this was written.

DROP INDEX IF EXISTS topups_by_period;
DROP TABLE IF EXISTS topups;
