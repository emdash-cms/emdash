---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Adds `ETag` and `Last-Modified` validators to media file responses and `/image` transforms, and returns `304 Not Modified` when a browser's `If-None-Match` or `If-Modified-Since` precondition matches. This lets cached mutable media (images that can be replaced under the same storage key) be revalidated with a single header exchange instead of re-downloaded on every visit. Storage backends now report `lastModified` with downloads where available (local filesystem, S3-compatible, and R2). The short `public, max-age=0, must-revalidate` cache lifetime for images is unchanged, so replacements still appear immediately.
