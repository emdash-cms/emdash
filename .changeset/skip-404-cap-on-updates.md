---
"emdash": patch
---

Fixes 404 logging to enforce the `MAX_404_LOG_ROWS` cap only when a new unique path is inserted. Repeat hits now skip the full-table `COUNT(*)`, significantly reducing D1 row reads for sites that serve many repeated 404s.
