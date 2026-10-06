---
"emdash": patch
---

Fix `_emdash_404_log` scheduled cleanup reading the whole table on every tick. `cleanup404Log()` ran a `DELETE ... WHERE id NOT IN (SELECT ... LIMIT)` eviction on every scheduled run regardless of row count, which scans the table twice and sorts into a temp B-tree. On D1 — where rows read is the billed and latency-driving unit — that scheduled scan dominated total row reads on sites whose cron runs frequently, even though the log was within its cap and nothing was evicted. The cleanup now first checks the row count (served by a covering index) and skips the eviction entirely when the table is within `MAX_404_LOG_ROWS`. Eviction behavior at and above the cap, including overlapping-run idempotency, is unchanged.
