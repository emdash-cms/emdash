---
"emdash": patch
---

Adds a `(created_at, id)` index to the media-usage table so the periodic cleanup sweep no longer scans and sorts the whole table when a backlog of stale rows builds up.
