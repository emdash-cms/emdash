---
"emdash": patch
---

Speeds up the admin content-list search on collections with full-text search enabled: the filter is now served from the FTS5 index (token-prefix matching plus slug-prefix lookup) instead of scanning every row. Collections without search enabled, and PostgreSQL databases, keep the previous substring matching.
