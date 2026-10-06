---
"@emdash-cms/cloudflare": patch
---

Fix Cloudflare sandbox `ctx.media.readBytes()` when media storage is configured

`PluginBridge.mediaReadBytes()` now reads bytes directly from the `MEDIA` R2 binding, matching `mediaUpload` and `mediaDelete`. It no longer relies solely on a media-storage callback registered on module-level state, which did not survive Worker Loader isolate/context boundaries under concurrent traffic and caused "Media storage is not configured" errors for sandboxed plugins with the `media:bytes:read` capability.
