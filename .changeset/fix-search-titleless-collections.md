---
"emdash": patch
---

Fixes search across all collections failing with `D1_ERROR: no such column: c.title` when any search-enabled collection has no `title` field (#1178). `title` is an optional field, not a guaranteed column, so calling `search` (or the MCP `search` tool) without a `collections` filter could error instead of searching everything. Cross-collection search now works regardless of which collections define a title; results from a collection without one simply omit the title, and autocomplete suggestions skip such collections rather than erroring.
