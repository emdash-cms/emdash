---
"@emdash-cms/admin": patch
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes HEIC uploads and previews when a site uses a compatible image service. External Astro image services can opt in with `image.service.config.supportedInputFormats: ["heic", "heif"]`; storage must provide a public source URL. Cloudflare Images bindings are supported automatically. Unsupported uploads return an error before storing the original, and admin previews use browser-ready renditions for storage-backed public URLs.
