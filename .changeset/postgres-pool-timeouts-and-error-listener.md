---
"emdash": patch
---

Fixes two Postgres pool faults that could hang requests or end the server process. An error raised on an idle pooled client — what a managed-database failover produces — was an unhandled event, which Node turns into an uncaught error that exits the process; the pool now logs it and keeps running, because node-postgres discards the bad client on its own. The `database` adapter's `pool` option also accepts `connectionTimeoutMillis` and `idleTimeoutMillis`, so a request that cannot reach the database fails on a bound you choose instead of waiting on the operating system's TCP timeout. Both are unset by default and node-postgres's own defaults still apply.
