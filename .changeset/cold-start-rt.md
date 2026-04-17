---
"emdash": patch
---

Improves cold-start performance for anonymous page requests. Sites with D1 replicas far from the worker colo should see the biggest improvement; on the blog-demo the homepage cold request on Asia colos dropped from several seconds to under a second.

Three underlying changes:

- Search index health checks run on demand (on the first search request) rather than at worker boot, reclaiming the time a boot-time scan spent walking every searchable collection.
- Module-scoped caches (manifest, taxonomy names, byline existence, taxonomy-assignment existence) are now reused across anonymous requests that route through D1 read replicas. They previously rebuilt on every request.
- Cold-start Server-Timing headers break runtime init into sub-phases (`rt.db`, `rt.plugins`, etc.) so further regressions are easier to diagnose.
