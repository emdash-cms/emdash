---
"emdash": patch
---

Restores the missing `idx_taxonomies_parent` index on `taxonomies(parent_id)`, which was silently dropped by the i18n table rebuild in an earlier version. Installs upgrade automatically; hierarchical (parent/child) taxonomy lookups are indexed again.
