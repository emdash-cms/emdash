---
"emdash": patch
---

Fixes `getEmDashCollection()` returning empty results when `where` or `orderBy` uses a custom field while migration `086_relations_structural` is pending. Reference fields become available on the next request after migrating, without waiting for the object cache to expire. Missing columns unrelated to caller fields are reported as collection-loading errors rather than filter warnings.
