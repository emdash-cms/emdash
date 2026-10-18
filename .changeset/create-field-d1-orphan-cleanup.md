---
"emdash": patch
---

Fixes `createField` on D1 leaving a field in the schema without a backing column when the collection reaches the column limit. Failed fields can now be created after freeing a column, without a `FIELD_EXISTS` error.
