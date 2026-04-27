---
"emdash": patch
---

Extends the storage-`publicUrl` fix so the REST API, local media provider, plugin context, and site-settings resolver all honor the configured CDN / custom domain. Previously the media list/upload/confirm endpoints, the signed-upload dedup path, the `createMediaAccessWithWrite().upload()` plugin capability, the local media provider's `list`/`get`/`getEmbed`/`getThumbnailUrl`, and `resolveMediaReference` in settings all hard-coded `/_emdash/api/media/file/{key}` — so JSON responses, plugin payloads, admin list thumbnails, and `site.logo.url` / `site.favicon.url` all round-tripped through the Worker even when a CDN was configured. Each site now goes through the `resolvePublicMediaUrl()` helper introduced by the render-layer fix.
