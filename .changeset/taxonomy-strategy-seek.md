---
"emdash": patch
---

Adds a `taxonomyStrategy: "seek"` option to `getEmDashCollection` for taxonomy-filtered listings. On SQLite/D1, filtering by a selective term (a fine-grained tag or category matching few entries) previously walked the whole collection in `orderBy` order — tens of thousands of D1 rows read for a page returning a handful. Pass `taxonomyStrategy: "seek"` on such archive routes to drive the query from the term instead, reading only the matching entries. The default (`"scan"`) is unchanged and remains best for non-selective terms. Also adds a composite index on `content_taxonomies(taxonomy_id, collection, entry_id)` that the seek plan relies on.
