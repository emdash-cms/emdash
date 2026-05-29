---
"emdash": patch
---

Migration 035 (`_emdash_404_log` bounded logging) no longer wedges on large tables. The dedup step previously used correlated subqueries against a window-function CTE; on Postgres each row of the `UPDATE` re-evaluated the entire CTE, making the migration O(n²) and effectively never completing on `_emdash_404_log` tables of ~100k rows or more (while blocking every subsequent emdash startup on the migration advisory lock). The dedup is now a single GROUP BY join — one linear pass — and logs the row count before it runs so operators can see the work scale rather than guessing it has hung. Fixes #1085.
