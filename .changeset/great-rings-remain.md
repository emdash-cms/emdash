---
"emdash": patch
---

Reduces SQLite and D1 rows read when listing plugin settings and other options by prefix, avoiding full-table scans while preserving existing prefix matching.

Adds an index through a database migration. Sites using `check` migration mode must apply pending migrations before the upgraded application can initialize. Sites using `manual` mode can continue without the migration, but must apply it to benefit from the index.
