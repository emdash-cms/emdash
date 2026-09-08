---
"emdash": patch
---

Chrome subsystems (site settings, menus, taxonomies and widget areas) now invalidate the Workers edge cache when mutated through the admin API, and public read helpers gained additive `*WithCacheHint` variants that return page-level cache hints. Stable invalidation tags are `emdash:settings`, `emdash:menu:<name>`, `emdash:taxonomy:<name>` and `emdash:widget-area:<name>`.
