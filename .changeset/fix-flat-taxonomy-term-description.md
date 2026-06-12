---
"emdash": patch
---

`getTaxonomyTerms()` now returns the term `description` for flat
(non-hierarchical) taxonomies (#1419)

The query already fetched the `data` column, but the non-hierarchical branch
dropped it when mapping rows to `TaxonomyTerm` — only hierarchical taxonomies
(via `buildTree`) parsed the description. Descriptions set in the admin UI are
now returned for both kinds of taxonomies.
