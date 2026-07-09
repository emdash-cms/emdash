---
"emdash": patch
---

Fixes plugin storage `query()` and `count()` failing on PostgreSQL with "operator does not exist: boolean = integer" whenever a `where` filter was supplied.
