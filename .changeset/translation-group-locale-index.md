---
"emdash": patch
---

Fixes translation lookups reading every non-deleted row of a content table. Content tables now carry `(translation_group, locale)` and `(deleted_at, translation_group, locale)` indexes, replacing the single-column `translation_group` one, so fetching an entry's translations — one entry's, a whole page's, or a menu link's target — seeks straight to the group instead of scanning. The improvement is largest on big collections and on D1, where the query planner has no statistics to fall back on.
