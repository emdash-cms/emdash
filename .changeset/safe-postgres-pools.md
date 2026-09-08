---
"emdash": patch
---

Fixes PostgreSQL deployments crashing when an idle pooled connection fails. EmDash now logs the idle-client error without exposing connection credentials while node-postgres discards the failed client and keeps the pool available.

The `postgres()` adapter's `pool` option also accepts `connectionTimeoutMillis` and `idleTimeoutMillis`. Set `connectionTimeoutMillis` to bound how long a request waits for a connection when PostgreSQL is unreachable. Both options remain unset by default, preserving node-postgres's existing timeout behavior.
