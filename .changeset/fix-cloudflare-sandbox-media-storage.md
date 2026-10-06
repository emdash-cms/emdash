---
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-test": patch
---

Fixes sandboxed plugins' `ctx.media.readBytes()` calls failing with "Media storage is not configured" under concurrent requests on Cloudflare Workers with an R2 `MEDIA` binding. Sites without that binding continue to use the existing storage callback fallback.

Updates `createPluginRuntimeTestHost()` to store media fixtures and uploads in its local R2 binding, so plugins can read their bytes through the production bridge.
