---
"emdash": patch
---

Fixes unpublished drafts appearing at the end of content lists on SQLite and D1 when a collection uses `dateField: "publishedAt"`. Sorting by published date now places entries without a publication date first in descending order and last in ascending order on every database, matching PostgreSQL. Other sort fields are unchanged.
