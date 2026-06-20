---
"emdash": patch
---

Fixes collection `where` taxonomy filters not matching localized term slugs (#1480). The loader's taxonomy filter joined `taxonomies` on `t.id = content_taxonomies.taxonomy_id`, but since the i18n migration the junction stores the term's `translation_group`, not a row id — the two coincide only for the default-locale term. As a result, filtering a non-default locale by its localized term slug matched nothing, and the filter silently ignored the query locale entirely. The join now keys on `translation_group` and scopes to the query locale (when one is set), matching the pattern used by every other taxonomy lookup, so localized term filtering works and a term slug resolves in the active locale.
