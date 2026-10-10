---
"emdash": patch
---

Fixes `createField` on D1 so a column-limit failure no longer leaves an orphaned `_emdash_fields` row behind. The field can now be created again once a column is freed.
