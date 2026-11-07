---
"emdash": patch
---

Fixes plugin storage `uniqueIndexes` rejecting duplicate field values in unrelated plugins and collections. Uniqueness now applies only to the collection that declares it, while indexed lookups remain available. A database migration repairs existing tracked unique indexes, including those left by plugins removed from configuration; no manual index cleanup is needed. Unique index names also keep case-distinct collections and fields separate on SQLite/D1 and avoid PostgreSQL truncation collisions. Existing regular lookup indexes retain their short names; tracked names longer than 63 characters may be rebuilt on the next storage-index sync, triggered by a write or scheduled task.

Sites with plugin storage unique indexes need a maintenance window for migration `095_plugin_storage_unique_scope`. Do not apply it in a pre-deploy migration job while older builds still serve traffic or scheduled work: they can recreate the non-partial constraints. Stop and drain old Node.js processes before migrating. On Workers, route traffic to maintenance and drain old invocations, deploy the upgraded build in `check` mode, then migrate and reopen traffic. Follow the platform-specific steps in the [upgrade guide](https://docs.emdashcms.com/deployment/updating/#fixed-plugin-storage-uniqueness).

If a previous index-name collision or manual index removal allowed duplicates in a declared unique field, the migration stops without deleting data or dropping legacy constraints. Resolve the duplicate values in the collection named by the error, then retry the migration.
