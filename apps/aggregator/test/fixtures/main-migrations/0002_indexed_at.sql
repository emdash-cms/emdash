-- Add `indexed_at` to the four content tables that the read API exposes via
-- the `packageView` / `releaseView` lexicon shapes.
--
-- Why a separate column from `verified_at`: `verified_at` tracks "when the
-- aggregator last verified this record", and is bumped on every upsert
-- (including no-op re-verifications). The read API needs "when the aggregator
-- first observed this record" so the lexicon's `indexedAt` field is stable
-- across re-ingest. They diverge whenever a record is re-fetched (e.g.
-- backfill catching up on a record we already had via Jetstream).
--
-- Defaulting to `verified_at` for any rows that pre-date this migration: the
-- closest approximation we can make for already-indexed content. Going
-- forward, the consumer's INSERTs set `indexed_at` to `now()` on first write
-- and COALESCE the existing value on conflict (see records-consumer.ts).
--
-- NOT NULL after backfill from `verified_at`. SQLite's `ALTER TABLE` doesn't
-- support DEFAULT-with-NOT-NULL in one step, so we add the column nullable,
-- backfill, then move the constraint via the new-table dance — except SQLite
-- also can't add NOT NULL via ALTER, so we keep the column nullable at the
-- schema level and have the writer (consumer) treat it as required. The
-- read-API code defends against NULL by falling back to verified_at if
-- indexed_at is somehow missing on a row, which won't happen for new writes
-- but covers the historical-data corner case without a table rebuild.

ALTER TABLE packages ADD COLUMN indexed_at TEXT;
UPDATE packages SET indexed_at = verified_at WHERE indexed_at IS NULL;

ALTER TABLE releases ADD COLUMN indexed_at TEXT;
UPDATE releases SET indexed_at = verified_at WHERE indexed_at IS NULL;

ALTER TABLE publishers ADD COLUMN indexed_at TEXT;
UPDATE publishers SET indexed_at = verified_at WHERE indexed_at IS NULL;

ALTER TABLE publisher_verifications ADD COLUMN indexed_at TEXT;
UPDATE publisher_verifications SET indexed_at = verified_at WHERE indexed_at IS NULL;
