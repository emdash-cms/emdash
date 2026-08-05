# Sequence 1 — Step 2 implementation

## Boundary

Step 2 adds reusable conditional primitives for one durable entry job and makes guarded projection redelivery capable of a true no-op. It does not select candidates, connect content writes, run a scheduler, change coverage/repair epochs, activate canonical reads, or expose APIs.

## Planned operations

- Claim only an exact due `pending`/`retry` version or an exact expired `leased` version, using database time and a repository-generated lease token.
- Complete, retry, or fail only the exact version, token, collection/content identity, `leased` state, and unexpired database lease.
- Retry/failure increments the current attempt count and clears ownership; the caller supplies the later measured retry delay, a stable error code, and decides whether an error is terminal.
- A newer mutation or lease takeover makes every stale transition lose without changing the row.

## Projection no-op

Projection fingerprints are versioned SHA-256 digests over immutable collection identity, content/source identity, all V1-visible source metadata, extraction schema version, and a canonical occurrence representation. Guarded replacement reports an explicit unchanged outcome only for the current expected row and a current-format matching fingerprint; legacy fingerprints are never matches. An unchanged projection writes neither a source generation nor occurrences.

## Tests and risks

Cross-dialect tests cover due-state claims, competing owners, expired takeover, stale/newer work fencing, completion, retry, terminal failure, fingerprint invalidation, and generation-preserving redelivery. SQLite always runs; PostgreSQL requires `EMDASH_TEST_PG`. Real D1/workerd behavior and measured lease/backoff/resource constants remain later acceptance work.
