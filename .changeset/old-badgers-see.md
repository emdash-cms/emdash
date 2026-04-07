---
"emdash": patch
---

Fixes `D1_ERROR: too many SQL variables` on the admin content list when a collection has ~100+ items. SEO and byline batch-hydration queries now chunk their `IN` clauses to stay under D1's 100-bound-parameter statement limit.
