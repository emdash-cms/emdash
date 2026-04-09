---
"emdash": patch
---

Fixes FTS5 table lifecycle in SchemaRegistry: createField now rebuilds the search index when a searchable field is added to a search-enabled collection; deleteField drops/rebuilds the FTS table when a searchable field is removed; deleteCollection drops the FTS virtual table before dropping the content table; updateCollection toggles the FTS table when search support is added or removed. Uses supports.includes("search") as the single source of truth for FTS state.
