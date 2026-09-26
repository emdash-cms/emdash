---
"emdash": patch
---

Fixes two `where` filters on collection queries. An object value with none of `gt`, `gte`, `lt` or `lte`, such as `{ in: [...] }`, now logs a warning instead of silently dropping the filter. Arrays whose values total more than 50 no longer fail on Cloudflare D1 with "too many SQL variables": the longest are each bound as one JSON parameter, so the query stays a single statement with ordering and paging in the database, on SQLite, D1 and PostgreSQL. Values in an array bound this way compare as text.
