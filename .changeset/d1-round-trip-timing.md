---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Adds D1 round-trip counts to the `rpc.count` Server-Timing metric, so sites on D1 can see how many physical database calls a request made alongside the logical query count. With `EMDASH_QUERY_LOG=1`, each request also logs an `[emdash-query-summary]` line with its query count, round trips, and rows read.
