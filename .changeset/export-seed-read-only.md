---
"emdash": patch
---

Fixes `emdash export-seed` changing the database it exports. The command now opens the source database read-only and stops with instructions to run `emdash migrate` when its schema is outdated, instead of applying pending migrations during an export.
