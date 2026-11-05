---
"emdash": patch
---

Fixes taxonomy `where` filters with long term-slug lists failing with D1's bound-parameter limit and returning an empty collection result with an error, including queries that combine taxonomy and field filters.
