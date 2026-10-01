---
"@emdash-cms/cloudflare": patch
---

Fixes Kysely `numAffectedRows` on the Durable Object SQL database backend and the preview database: writes now report the number of changed table rows (SQLite `changes()`) instead of `rowsWritten`, which also counts index entries. This resolves false `stale` outcomes when fencing a collection for deletion with media-usage tracking enabled, and fixes any other `numAffectedRows` / `numUpdatedRows` comparisons against indexed tables.
