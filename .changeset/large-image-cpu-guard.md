---
"emdash": minor
"@emdash-cms/admin": patch
---

Reduces CPU usage during image upload confirmation by generating placeholders from small browser thumbnails instead of decoding full-resolution originals. The admin and visual-editing toolbar now send thumbnails fitting a 64-pixel box with signed and direct uploads. This also enables blurhash and dominant-color placeholders for browser-decodable formats such as WebP and AVIF, which previously had none. Transparent images also receive placeholders, whose backgrounds can remain visible through transparent areas in the built-in image components. Image dimensions, upload validation, content hashing, and responsive image variants remain unchanged.

Adds the `imagePlaceholders` configuration option, defaulting to `true` on every runtime, including Cloudflare Workers. This is one site-wide switch for every upload and import: setting it to `false` skips all blurhash and dominant-color generation, including from client thumbnails. WordPress imports, MCP uploads, plugin uploads, and custom clients without thumbnails still decode originals when placeholders are enabled, so sites with constrained CPU budgets may choose to turn this switch off.

Custom clients can send an optional `{ thumbnail: { contentType, data } }` in `POST /_emdash/api/media/{id}/confirm`. Confirm thumbnails accept JPEG or PNG, at most 32,768 base64 characters and 4,096 decoded pixels. Unusable thumbnails omit the placeholder rather than falling back to decoding the original. Thumbnails also work when originals exceed the 8 MiB download cap; supply the original `width` and `height` to record dimensions in that case.
