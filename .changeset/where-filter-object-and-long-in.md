---
"emdash": patch
---

Fixes `getEmDashCollection`'s `where` filter so an object with none of `gt`, `gte`, `lt` or `lte` (such as `{ in: [...] }`) now logs a warning instead of silently returning unfiltered rows. Long array values no longer fail on Cloudflare D1 with "too many SQL variables": the longest arrays are each bound as one JSON parameter, keeping ordering and paging in the database on SQLite, D1 and PostgreSQL. Values bound that way compare as text.
