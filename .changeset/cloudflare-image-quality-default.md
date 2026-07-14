---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes oversized image renditions on Cloudflare: transforms without an explicit quality were encoded near-losslessly by the Images binding (a 2048px WebP came out ~900 KB instead of ~100 KB). Transforms now default to quality 85, matching Cloudflare's image-resizing default.
