---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes HEIC media handling by using the configured image service for browser-ready renditions and rejecting uploads when that service cannot support HEIC input.
