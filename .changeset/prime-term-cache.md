---
"emdash": patch
---

Prime the request-scoped cache for `getEntryTerms` during collection and entry hydration. `getEmDashCollection` and `getEmDashEntry` already fetch taxonomy terms for their results via a single batched JOIN; now the same data is seeded into the per-request cache under the same keys `getEntryTerms` uses, so existing templates that still call `getEntryTerms(collection, id, taxonomy)` in a loop get cache hits instead of a serial DB round-trip per iteration.

Empty-result entries are seeded with `[]` for every taxonomy that applies to the collection so "this post has no tags" also short-circuits without a query. Cache entries are scoped to the request context via ALS and GC'd with it.
