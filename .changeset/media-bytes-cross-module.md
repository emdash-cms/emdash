---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugins on Cloudflare reporting that media storage is not configured when `ctx.media.readBytes()` reads an R2-backed media item.
