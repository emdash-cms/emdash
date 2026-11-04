---
"emdash": patch
---

Speeds up `getEmDashCollection()` listings on SQLite and D1 that filter by two or more taxonomies and no content fields. The listing now starts from the taxonomy filter with the smallest estimated number of assigned entries, instead of the taxonomy the `where` object names first, so a broad taxonomy listed first no longer makes the listing read every entry assigned to it. The estimate is capped at 200 entries per filter and rounds a filter with several slugs up when one of its terms is large, so two filters close in size can still start from the slightly larger one. To take the estimate, the term lookup reads up to about 200 extra index entries per taxonomy filter. Postgres listings are unchanged.
