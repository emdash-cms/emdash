---
"emdash": patch
---

Fixes the WordPress importer so collections created mid-import are visible to the subsequent execute phase.

`POST /_emdash/api/import/wordpress/prepare` now calls `emdash.invalidateManifest()` when it creates new collections or fields. Without this, the DB-persisted manifest cache (`emdash:manifest_cache` in the `options` table) stays stale and the `execute` request reports `Collection "<slug>" does not exist` for every item destined for a freshly created collection — a bug that survived dev-server restarts and required manually deleting the cache row.
