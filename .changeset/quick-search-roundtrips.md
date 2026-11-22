---
"emdash": patch
---

Improves search and autocomplete latency across multiple collections on D1 when query coalescing is enabled. Reduces first-search index health checks to a small number of database round trips while preserving automatic repair of missing or empty indexes.
