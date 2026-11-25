---
"emdash": patch
---

Fixes `PUT /_emdash/api/content/{collection}/{id}` with `status: "draft"` so it unpublishes a published or scheduled entry the same way `POST .../unpublish` and the `content_update` MCP tool do. The request now needs `content:publish_own` or `content:publish_any`, a `content:beforeUnpublish` hook can reject it, `content:afterUnpublish` hooks run, and the live revision and any pending schedule are cleared. Other fields in the same request are saved first. If the unpublish then fails, the error says the fields were saved, and its `details._rev` is the `_rev` of that save. A draft that still has a live revision or pending schedule from an earlier version is unpublished the same way. On any other draft, `status` is ignored.
