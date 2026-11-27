---
"emdash": minor
---

Adds `DELETE /_emdash/api/content/{collection}/trash` and the `content_empty_trash` MCP tool, so Admins can empty a collection's trash. Each call permanently deletes one batch of trashed entries, with the same cleanup as deleting them one at a time, and returns `{ deleted, remaining }`. Repeat the call until `remaining` is 0. Pass `?locale=` (or `locale` to the MCP tool) to empty only that locale's trash.
