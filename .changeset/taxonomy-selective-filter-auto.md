---
"emdash": patch
---

Speeds up taxonomy-filtered content listings on SQLite/D1. Filtering `getEmDashCollection` by a selective term (a fine-grained tag or category matching few entries) previously walked the whole collection in `orderBy` order — tens of thousands of D1 rows read for a page returning a handful. The loader now detects term selectivity automatically and drives the query from the most selective term (and, for multi-term filters, from the smallest), reading only the matching entries; broad terms keep the fast scan. No API changes; Postgres is unchanged.
