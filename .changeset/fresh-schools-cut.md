---
"emdash": patch
---

Removes two redundant in-scope database queries from the FTS verify-and-repair path. The inner block re-fetched searchable fields and search config that were already loaded in the outer scope of the same method. No behavior change.
