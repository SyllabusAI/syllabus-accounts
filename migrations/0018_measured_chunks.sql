-- What a provider measured a chunk to be, so a second pass on the same bytes
-- is billed on that length and not on anything the caller wrote (F-21).
--
-- A `quality=high` pass goes to gpt-4o-transcribe, whose answer carries no
-- duration, so on its own it could only be billed on the caller's mp4
-- header and a byte floor that low-bitrate audio gets under. The standard
-- pass on Groq does report a duration. Its value is kept here, keyed by the
-- account and a SHA-256 of the exact bytes, and a high pass is refused
-- unless it finds one.
--
-- The hash identifies audio the account already sent; it is not the audio
-- and cannot be turned back into it. Rows live a day (the hourly cron sweeps
-- them) and go with the account when it is deleted.

CREATE TABLE measured_chunks (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chunk_hash  TEXT NOT NULL,
  seconds     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, chunk_hash)
);

CREATE INDEX measured_chunks_created ON measured_chunks (created_at);
