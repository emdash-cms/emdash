---
"@emdash-cms/cloudflare": patch
---

Fixes the Cloudflare image endpoint (`/_image` for EmDash media URLs) holding the R2 object read open after it answers with `304 Not Modified`, answers a `HEAD` request for a file it serves without transforming, or fails to transform an image.
