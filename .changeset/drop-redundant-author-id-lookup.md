---
"emdash": patch
---

Removes a redundant `SELECT id, author_id` lookup that fired after every collection-list and entry fetch when computing the byline-fallback for entries without explicit credits. The column is already on the row data, so it is now read directly. Saves up to one round-trip per list query and two on post-detail routes (~30 fewer queries across the perf-fixture suite).
