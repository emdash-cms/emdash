---
"emdash": patch
---

Fixes collection `where` field filters so unsupported range objects warn instead of silently disappearing, and large array filters are split into D1-safe `IN` chunks.
