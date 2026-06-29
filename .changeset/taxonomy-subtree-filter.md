---
"emdash": minor
---

Adds a `subtree` operator to collection `where` taxonomy filters (`where: { category: { subtree: "news" } }`) that matches a term and all its descendants. Descendants are resolved in the database, so selecting a deep parent category no longer hits SQL bind-parameter limits. Also adds an opt-in `rollup` option to `getTaxonomyTerms` (and the admin terms endpoint via `?rollup=1`) for subtree-aware usage counts that count each entry once.
