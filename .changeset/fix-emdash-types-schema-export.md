---
"emdash": patch
---

Fixes `emdash types` crashing with "Cannot read properties of undefined (reading 'collections')". The client's `schemaExport()` routed through the enveloped `request()` helper, but the `/schema` endpoint returns a bare `{ collections, version }` object — it now reads the raw response directly.
