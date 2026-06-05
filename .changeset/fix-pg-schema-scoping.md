---
"emdash": patch
---

Scope Postgres table/column introspection to the connection's active schema instead of hardcoding `public`. `tableExists` and `listTablesLike` (`database/dialect-helpers.ts`) and two idempotency checks in the `019_i18n` migration queried `information_schema` with `table_schema = 'public'`, so a Postgres deployment using a non-public schema (per-tenant or shared-cluster setups) would see tables from the wrong schema or none at all, causing collection/schema operations to misbehave and the i18n migration to skip its column additions. These now use `current_schema()`, matching the already-correct `indexExists`/`columnExists` helpers and migration `038`.
