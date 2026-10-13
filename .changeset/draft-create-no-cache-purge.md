---
"emdash": patch
---

On sites that use a route cache such as Workers Cache, creating or duplicating an entry no longer purges cached pages. The new entry is a draft that no public page shows, so pages that list the collection stay cached until a later change to published content. This applies to `POST /_emdash/api/content/{collection}`, `POST /_emdash/api/content/{collection}/{id}/duplicate`, and the `content_create` and `content_duplicate` MCP tools. `content_create` with `status: "published"` still purges the collection and the new entry.
