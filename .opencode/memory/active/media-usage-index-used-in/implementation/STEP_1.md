# Sequence 1 — Step 1 implementation

## Boundary

Step 1 expands the schema and provides a reusable, dialect-aware capture-trigger installer. Migration `057_media_usage_incremental_work` leaves the singleton activation state at `expanded`; it neither installs triggers nor changes V1 reads. Activation, collection-lifecycle orchestration, workers, retries, repair integration, deletion cleanup, and APIs remain later work.

## Schema

- `_emdash_media_usage_activation` is a singleton rollout fence with durable `expanded`/`activating`/`active` state, cursor, lease, attempt, error, drain-confirmation, and activation timestamps.
- `_emdash_media_usage_work` coalesces work by immutable `(collection_id, content_id)`, versions newer mutations, and stores pending/retry/lease/failure state. Due, expired-lease, and bounded operator indexes support later processing.
- Content-collection status rows gain immutable collection identity, epoch, reconciliation, capture lifecycle, incremental-success, and deletion-cleanup checkpoint/lease fields.
- Sources gain nullable `collection_id` and `identity_version`. Existing sources and fingerprints remain unbound and unchanged.
- Expansion binds only current `content-media` collection status rows, removes unmatched legacy status metadata, creates no historical work, and performs no content-table scan.

## Capture triggers

SQLite/libSQL/D1 use three table-specific row triggers. PostgreSQL uses one shared trigger function plus table-specific triggers. Names contain the trigger-contract version and a 128-bit SHA-256 identity suffix, and remain below PostgreSQL's 63-byte limit. Catalog verification checks the exact SQLite definition or PostgreSQL event, function and identity arguments before accepting a no-op. Every trigger matches the embedded collection ID and slug against both an `active` status row and the live registry row, advances the epoch, invalidates complete coverage, and upserts one pending work row. Any missing guard or work failure aborts the entire content statement.

Database time is stored as sortable UTC ISO text. A complete current trigger set makes repeated installation a no-op. Missing, partial, or stale sets are repaired only while the durable lifecycle is `installing`, and still require an external writer fence or a table that is not yet reachable: a non-active lifecycle cannot guard an operation whose trigger is absent.

## Tests and dialect limits

Cross-dialect integration tests cover migration preservation/idempotency, expansion-only compatibility, insert/update/delete coalescing, state reset, inactive or mismatched lifecycle rejection, repeated installation, and multi-row all-or-nothing rollback. SQLite always runs; PostgreSQL runs when `EMDASH_TEST_PG` is configured. These tests do not claim real D1/workerd coverage; that smoke test remains required before the complete Sequence 1 implementation is review-ready.

## Remaining risks

- Capture cost is proportional to rows affected by a statement; supported bulk-writer limits are measured in later steps.
- Existing collection activation still requires the approved external writer drain.
- Migration rollback refuses to discard active lifecycle state, pending work, canonical identities, or installed capture triggers.
- New/seed/orphan/deletion lifecycle ordering is not switched on by Step 1; doing so safely requires the later durable lifecycle orchestration.
- PostgreSQL coverage is skipped when no test server is configured, and real D1 syntax/budget behavior is not exercised here.
