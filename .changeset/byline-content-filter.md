---
"emdash": minor
---

Add native content filtering by byline credit. `getEmDashCollection` (and `getLiveCollection`) now accept a reserved `byline` key in `where` that matches entries credited to one or more byline translation groups via the `_emdash_content_bylines` junction table. Unlike filtering on `primary_byline_id`, this matches every explicit credit, so co-authored entries where the byline is a secondary credit are included, which makes author archive pages correct without dropping to raw DB access. Accepts a single group or an array (OR), and combines with taxonomy, field, locale, status, and ordering filters.

Also exposes a `getEntriesByByline(collection, byline, options)` runtime helper that wraps the new filter, mirroring `getEntriesByTerm`.
