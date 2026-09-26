---
"emdash": patch
---

Fixes taxonomy-filtered `getEmDashCollection()` listings on D1 and SQLite reading up to the whole collection when the term has fewer than 200 entries, the listing is sorted by `updated_at`, or it filters by several terms. These listings now read only the term's entries. A single term with 200 or more entries, sorted by `published_at` or `created_at`, is still read in date order and stops once the page is full.
