---
"emdash": patch
---

Fixes slow collection-list pages on SQLite/D1: folded taxonomy-term hydration now drives its subquery from the content–taxonomy pivot instead of scanning every term in the locale per row, so list pages no longer read tens of thousands of rows on sites with large taxonomies.
