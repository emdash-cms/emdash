---
"emdash": patch
---

Speeds up `getEmDashCollection()` listings on SQLite and D1 that filter by two or more taxonomies and no content fields. When one of the taxonomy filters has fewer than 200 assigned entries in the collection, the listing now starts from the filter with the fewest entries instead of the taxonomy the `where` object names first, so a broad taxonomy listed first no longer makes the listing read every entry assigned to it. To pick the starting filter, the term lookup reads up to about 200 extra index entries per taxonomy filter. Postgres listings are unchanged.
