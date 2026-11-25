---
"emdash": patch
---

Fixes `PUT /_emdash/api/content/{collection}/{id}` with `status: "draft"` so it unpublishes a published or scheduled entry the same way `POST .../unpublish` and the `content_update` MCP tool do. The request now needs `content:publish_own` or `content:publish_any`, a `content:beforeUnpublish` hook can reject it, `content:afterUnpublish` hooks run, and the live revision and any pending schedule are cleared. Other fields in the same request are saved first. On an entry that is already a draft, `status` is ignored.
