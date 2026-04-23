---
"emdash": patch
---

Fixes an unauthenticated denial-of-service via the 404 log. Every 404 response previously inserted a new row into `_emdash_404_log`, so an attacker could grow the database without bound by requesting unique nonexistent URLs. Repeat hits to the same path now dedup into a single row with a `hits` counter and `last_seen_at` timestamp, referrer and user-agent headers are truncated to bounded lengths, and the log is capped at 10,000 rows with oldest-first eviction.
