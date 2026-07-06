---
"emdash": patch
---

Speeds up taxonomy term lookups on SQLite/D1 by adding a composite `taxonomies(name, locale)` index. Previously the query planner scanned every term in a locale to resolve a single taxonomy, so pages rendering several facets paid a full-locale scan per facet on sites with large taxonomies. A forward-only migration adds the index and drops the now-redundant single-column name index.
