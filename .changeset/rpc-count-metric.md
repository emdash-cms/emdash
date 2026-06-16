---
"emdash": patch
---

Adds an `rpc.count` Server-Timing metric reporting physical database round trips, distinct from `db.count` (logical queries). Backends that batch (the new Durable Objects SQL driver coalesces same-turn reads into one round trip) can now surface how many round trips a request actually made.
