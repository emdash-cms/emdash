---
"emdash": patch
---

Fixes plugins declaring the `media:write` capability receiving a read-only `ctx.media` with no `upload()`. The plugin context only granted a writable media surface when an internal upload-URL provider was wired, which the runtime never supplied — so `ctx.media.upload()` was always `undefined`. Write access is now granted whenever storage is configured (all `upload()` needs), and `getUploadUrl()` is derived from storage when no provider is set. A `media:write` plugin on a site without storage now logs a warning instead of silently degrading to read-only.
