---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes built-in search endpoints on PostgreSQL, including Hyperdrive, so they report `503 SEARCH_UNAVAILABLE` instead of returning generic errors or misleading empty results. PostgreSQL search is still unavailable; use a SQLite-family database with FTS5 for built-in full-text search. The editor's link picker explains that content search is unavailable and suggests pasting a URL, without retrying the unsupported search or blaming the network connection.
