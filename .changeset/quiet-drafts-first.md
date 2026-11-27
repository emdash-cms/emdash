---
"emdash": patch
---

Fixes unpublished drafts appearing on the last page of the admin content list on SQLite and D1 when a collection uses `dateField: "publishedAt"`. When the admin list or the content API sorts by published date, entries without a publication date now come first in descending order and last in ascending order on every database, matching PostgreSQL. Other sort fields and frontend `getEmDashCollection` ordering are unchanged.

On SQLite and D1, API clients paging with a published-date cursor should discard in-progress cursors and restart from the first page after upgrading, because the position of entries without a publication date has changed.
