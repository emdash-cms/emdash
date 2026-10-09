---
"emdash": patch
---

Fixes full-text search so queries containing lowercase words like "and", "or", "not" or "near" are no longer parsed as FTS5 operators. This restores results for searches with possessive apostrophes and keeps prefix matching for those queries.
