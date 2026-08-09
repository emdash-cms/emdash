---
"emdash": patch
---

Adds an index on the media-usage table's `created_at` column so the periodic cleanup sweep no longer scans the whole table when a backlog of stale rows builds up.
