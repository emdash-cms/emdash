---
"emdash": minor
"@emdash-cms/admin": patch
---

Reduces CPU usage during image upload confirmation by generating placeholders from small browser thumbnails instead of decoding full-resolution originals. The admin and visual-editing toolbar now send thumbnails fitting a 64-pixel box with signed and direct uploads. This also enables blurhash and dominant-color placeholders for browser-decodable formats such as WebP and AVIF, which previously had none. Image dimensions, upload validation, content hashing, and responsive image variants remain unchanged.

Adds the `imagePlaceholders` configuration option, defaulting to `true` on every runtime, including Cloudflare Workers. Set it to `false` to skip blurhash and dominant-color generation. On CPU-constrained runtimes, consider disabling placeholders for WordPress imports, MCP uploads, plugin uploads, or custom upload clients without thumbnails: these paths still decode originals for placeholders.

Custom clients can send an optional `{ thumbnail: { contentType, data } }` in `POST /_emdash/api/media/{id}/confirm`. Confirm thumbnails accept JPEG or PNG, at most 32,768 base64 characters and 4,096 decoded pixels. Unusable thumbnails omit the placeholder rather than falling back to decoding the original. Thumbnails also work when originals exceed the 8 MiB download cap; supply the original `width` and `height` to record dimensions in that case.
