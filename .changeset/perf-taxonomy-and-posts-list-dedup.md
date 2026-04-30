---
"emdash": patch
---

Reduces duplicate queries on pages that render multiple taxonomy or "recent posts" widgets. `getTaxonomyDef(name)` now reuses the full taxonomy-defs list when it has already been loaded in the same request, and `getEmDashCollection` buckets small limits so a post-detail page asking for 4 posts in the body and 5 in a sidebar widget shares one fetch instead of two. Cuts ~6 queries from the perf-fixture post-detail render.
