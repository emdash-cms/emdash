---
"emdash": patch
---

Fixes creating a translation when the collection has a non-translatable reference field. The create failed, and on PostgreSQL the API reported the collection as missing.
