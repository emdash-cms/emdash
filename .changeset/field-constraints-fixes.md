---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes several field constraint issues: unique fields now enforce uniqueness at the database level (including across draft revisions), making a field required backfills existing NULL values and syncs the column constraint, reserved field slugs are expanded to prevent conflicts with internal columns, orphaned field data is cleaned up on content hard-delete and collection delete, and repeater/multiSelect fields validate minItems/maxItems at runtime.
