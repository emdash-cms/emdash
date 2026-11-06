---
"emdash": patch
---

Fixes plugin storage `uniqueIndexes` rejecting duplicate field values in unrelated plugins and collections. Uniqueness now applies only to the collection that declares it, while indexed lookups remain available. A database migration repairs existing tracked unique indexes, including those left by plugins removed from configuration; no manual index cleanup is needed. Unique index names also keep case-distinct collections and fields separate on SQLite/D1 and avoid PostgreSQL truncation collisions. Existing regular lookup indexes retain their short names; tracked names longer than 63 characters may be rebuilt on the next storage-index sync, triggered by a write or scheduled task.

If a previous index-name collision or manual index removal allowed duplicates in a declared unique field, the migration stops without deleting data or dropping legacy constraints. Resolve the duplicate values in the collection named by the error, then retry the migration.
