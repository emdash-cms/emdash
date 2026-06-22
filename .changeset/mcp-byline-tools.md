---
"emdash": minor
---

Adds byline management to the MCP server: `byline_list`, `byline_get`, `byline_create`, `byline_update`, `byline_delete`, and `byline_translations` tools, plus a `bylines` argument on `content_create` so credits can be attached at creation time (previously only `content_update` accepted them).
