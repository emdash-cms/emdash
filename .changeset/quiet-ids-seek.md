---
"emdash": patch
---

Fixes `getEmDashCollection()` with `where: { id: [...] }` on SQLite walking the whole collection once `ANALYZE` has run on a database with trashed entries. The requested ids are now looked up by primary key; other list queries are unchanged.
