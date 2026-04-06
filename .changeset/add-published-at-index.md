---
"emdash": patch
---

Adds composite index on (deleted_at, published_at DESC, id DESC) to eliminate full table scans for frontend listing queries that order by published_at. Also adds redirect table indexes for efficient redirect matching.
