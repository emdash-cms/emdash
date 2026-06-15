---
"emdash": patch
---

Fix search and suggestions failing with `D1_ERROR: no such column: title` when a searchable collection has no `title` field. The query now detects whether the collection defines a title field and only selects it when present.
