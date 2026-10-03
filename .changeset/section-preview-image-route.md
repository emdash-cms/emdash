---
"emdash": patch
---

Fixes section preview images in the admin's Sections screen and section picker, which never loaded: `getSection()` and the sections API returned a `previewUrl` under `/_emdash/media/`, a path nothing serves, so every preview image request answered 404. The URL now uses the media file route, `/_emdash/api/media/file/<key>`, like every other media reference. The OpenAPI `Section` response schema now documents the `previewUrl` field the sections API returns.
