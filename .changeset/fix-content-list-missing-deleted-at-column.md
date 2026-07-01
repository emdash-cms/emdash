---
"emdash": patch
---

Fixes the admin content list returning a generic `CONTENT_LIST_ERROR` when a collection's backing table is missing the `deleted_at` column. It now returns `COLLECTION_SCHEMA_MISMATCH` naming the affected collection, so the schema problem is visible instead of an opaque failure.
