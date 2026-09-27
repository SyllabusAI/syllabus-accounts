-- Study assistant sessions, the unit Pro is sold in.
--
-- Pro includes 15 study sessions a month (allowances.assistant_sessions,
-- migrations/0010). Until now nothing could count them, because the assistant
-- ran on one Mac's own Anthropic key and never reached this service.
-- /proxy/assistant (src/assistant.ts) is where it runs now, and this table is
-- what it counts.
--
-- A session is a window, not a question. HOME-STRETCH prices one as a cache
-- write plus eight follow-ups: the summaries for a course are sent once,
-- cached, and every later question in the same sitting reads them for a tenth
-- of the price. So a row is opened by the first question, and later questions
-- carry its id and ride on it until it runs out of questions, time, or money,
-- whichever comes first. The limits themselves are constants in
-- src/assistant.ts; this table only records what has been used of them.
--
-- Opening a row is the charge. It is inserted by a statement that counts the
-- account's rows for the period in the same breath, which is the reservation
-- pattern from migrations/0007: two first questions arriving together cannot
-- both find the last session free.
--
--   questions    how many questions this session has answered
--   escalations  how many of them went to full transcripts; at most one each
--   spent        what the session has cost, in millionths of a dollar,
--                reserved before each call and settled after it
--
-- No question, answer, course, or lecture text is stored. The course is not
-- recorded either: a session is not bound to one, and the dollar figure is
-- what the cap is about.
--
-- The dollar figure is also written to usage (kind 'assistant', units in
-- millionths of a dollar), because usage is what the global ceiling and the
-- bill read. Two tables, one number each: usage is the bill, this is the
-- entitlement.

CREATE TABLE assistant_sessions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  period      TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  questions   INTEGER NOT NULL DEFAULT 0,
  escalations INTEGER NOT NULL DEFAULT 0,
  spent       INTEGER NOT NULL DEFAULT 0
);

-- The allowance check: how many sessions this account has opened this month.
CREATE INDEX assistant_sessions_by_period ON assistant_sessions (account_id, period);
