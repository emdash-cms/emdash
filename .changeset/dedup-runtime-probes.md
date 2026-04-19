---
"emdash": patch
---

Dedups repeat DB queries within a single page render. Measured against the query-count fixture:

- The "has any bylines / has any taxonomy terms" probes were module-scoped singletons, but the bundler duplicates those modules across chunks — each chunk ended up with its own copy of the singleton, so the probe re-ran whenever a different chunk called the helper. Stored on `globalThis` with a Symbol key (same pattern as `request-context.ts`), so a single value is shared across all chunks now.
- Wraps `getCollectionInfo`, `getTaxonomyDef`, `getTaxonomyTerms`, and `getEmDashCollection` in the request-scoped cache so two callers with the same arguments in the same render share a single query.

Biggest wins land on pages that render multiple content-heavy components (a post detail page with comments, byline credits, and sidebar widgets). On the fixture post page: -3 queries cold / -1 warm under SQLite, -2 queries cold under D1.
