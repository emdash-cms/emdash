---
"emdash": patch
---

Fixes `getSiteSettings()` and `getSiteSetting()` ignoring the storage `publicUrl`. On sites that serve media from an R2 custom domain or S3 CDN, the site logo, favicon, and default social image now use that URL instead of `/_emdash/api/media/file/`. Admin and REST API responses keep the internal route.

Also fixes `<Media>` throwing "Local media provider requires database connection" when rendering media from the media library. It now renders local media with the storage `publicUrl` when one is configured.
