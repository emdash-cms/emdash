---
"emdash": minor
---

Adds field-level and range filtering to `getEmDashCollection`'s `where` option. Previously, only taxonomy-based keys were processed via JOIN; non-taxonomy field names were silently discarded. Now the `where` clause supports exact match (`string`), multi-value match (`string[]`), and range comparisons (`{ gt?, gte?, lt?, lte? }`) on any content table column, all executed at the SQL layer with parameterized queries.
