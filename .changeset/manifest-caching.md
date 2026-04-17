---
"emdash": patch
---

Caches the manifest in memory and in the database to eliminate N+1 schema queries per request. Batches site info queries during initialization. Cold starts read 1 cached row instead of rebuilding from scratch.
