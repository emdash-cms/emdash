---
"emdash": patch
---

Fixes taxonomy-filtered `getEmDashCollection()` listings sorted by `published_at` or `created_at` (the default) on D1 and SQLite reading up to the whole collection when the term has fewer than 200 entries or the listing filters by several terms. These listings now read only the term's entries. A single term with 200 or more entries is still read in date order and stops once the page is full.
