---
"emdash": patch
---

Fixes `getEmDashCollection()` and `getEmDashEntry()` returning SQLite-backed boolean fields as `0` or `1`. Boolean fields now return `true` or `false`, matching their generated TypeScript types, while integer fields retain numeric values.
