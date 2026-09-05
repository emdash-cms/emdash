---
"emdash": patch
---

Adds an `includeCounts` option to `getTerm()`, matching `getTaxonomyTerms()`. Pass `includeCounts: false` to get a term's label, slug and children without its entry count, which skips the aggregate over the taxonomy's assignments. Counts are still included by default. The built-in category and tag archive pages, which render only the label, opt out.
