---
"emdash": patch
---

Fixes `getEmDashCollection()` returning empty results when a `where` or `orderBy` uses a custom field while core migrations before `086_relations_structural` are still pending. The loader now tolerates a missing `_emdash_relations.slug` column during the reference-field lookup, and missing columns on system tables are surfaced as errors instead of being misreported as a caller filter problem.
