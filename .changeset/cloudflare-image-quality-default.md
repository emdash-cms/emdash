---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes oversized image renditions on Cloudflare: transforms without an explicit quality were encoded near-losslessly by the Images binding (a 2048px WebP came out ~900 KB instead of ~100 KB). Lossy transforms (WebP/AVIF/JPEG) now default to quality 85, matching Cloudflare's image-resizing default. PNG output keeps no explicit quality — an explicit PNG quality switches the binding to lossy PNG8, which is not a safe default for a lossless format. An explicit `?q=` in the request URL still wins for every format.

Note: image responses are cached with `Cache-Control: immutable, max-age=31536000` keyed on the request URL, so previously-served oversized renditions stay cached at the edge/browser until they expire. To benefit immediately after upgrading, purge the Cloudflare cache for your `/_image*` URLs (or the whole site cache).
