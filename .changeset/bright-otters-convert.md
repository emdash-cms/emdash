---
"emdash": patch
---

Fixes stored media thumbnails failing on Node sites that use an external Astro image service. EmDash forwards the storage adapter's public URL and replacement version to the configured service, allowing HEIC previews when that service supports HEIC. The source URL must be accessible to the service.
