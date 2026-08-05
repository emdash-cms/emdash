# Sequence 1 — Step 3 implementation

## Boundary

Step 3 connects trigger-created entry work to the authenticated post-write path and to the existing Cloudflare/Node maintenance heartbeat. It does not activate collections, change coverage/repair epochs, add operator APIs, or implement later acceptance/measurement work.

## Processing flow

- Before global activation, successful writes retain the released synchronous V1 refresh/delete behavior.
- After activation, the fast path resolves the current collection instance, conditionally claims only that entry's due work version, reconciles current database truth, and conditionally acknowledges the exact live lease.
- The scheduled driver uses the due, retry, and expired-lease indexes, merges a bounded candidate page, skips claim losers, and processes jobs sequentially through the same processor. Cloudflare calls it through `runScheduledTasks`; Node calls it from the timer maintenance callback.
- Canonical projections use immutable collection identity. Every canonical source write/delete rechecks the current registry ID and slug; obsolete-instance work is acknowledged without touching a replacement collection.

## Initial bounds

- return at most 4 due candidates after three index-backed probes capped at 4 rows each, and claim at most 1 job per scheduled tick;
- admit no new job after 5 seconds;
- lease one job for 60 seconds;
- retain a terminal failure after 5 failed attempts;
- retry from 30 seconds, capped at 15 minutes, with up to 25% jitter.
- keep an ordinary single-source job at or below 20 top-level database statements.

These conservative exported limits leave headroom below Cloudflare's 50-query Free invocation limit, 100-bind query limit, and 30-second query limit. Behavioral tests measure the ordinary statement ceiling and generation-preserving no-op path; the final large-entry resource gate remains later work.

## Failure behavior and tests

Tests cover bounded/order-stable selection, immediate processing, duplicate/claim races, lease expiry, stale completion, projection no-op redelivery, retry/terminal transitions, entry deletion, and independent Cloudflare/Node scheduling. Process death before claim leaves pending work; death after claim recovers after expiry; death after projection redelivers as a fingerprint no-op; a newer work version cannot be acknowledged by the old owner.

## Remaining risks

- A single accepted entry can still contain many occurrences; the full resource-admission measurement and terminal resource envelope remain a later Sequence 1 acceptance task.
- Real PostgreSQL and D1/workerd verification remain required even though shared SQLite/PostgreSQL tests exercise the portable behavior.
- Hosts without scheduled maintenance retain durable work but receive no automatic freshness deadline.
