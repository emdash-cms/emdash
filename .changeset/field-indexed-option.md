---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an `indexed` option to custom fields. When enabled, a B-tree index is created on the field's column, improving query performance for fields used in filters or sorting. Toggle it in the field editor or set `indexed: true` in seed definitions.
