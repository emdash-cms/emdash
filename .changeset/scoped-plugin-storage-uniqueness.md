---
"emdash": patch
---

Fixes plugin storage `uniqueIndexes` rejecting duplicate field values in unrelated plugins and collections. Uniqueness now applies only to the collection that declares it, while indexed lookups remain available. A database migration repairs existing tracked unique indexes, including those left by plugins removed from configuration; no manual index cleanup is needed. Long index names now keep separate constraints for each declaring collection on PostgreSQL instead of colliding when truncated.

If a previous index-name collision or manual index removal allowed duplicates in a declared unique field, the migration stops without deleting data or dropping legacy constraints. Resolve the duplicate values in the collection named by the error, then retry the migration.
