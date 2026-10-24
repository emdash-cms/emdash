---
"emdash": patch
---

Fixes signed-URL media confirmations exceeding CPU limits on large JPEGs by skipping server-side placeholder generation for decoded images above 4 megapixels.

The generatePlaceholder guard now rejects images whose pixel area exceeds `MAX_DECODE_PIXELS` (4,000,000) before invoking jpeg-js, protecting constrained runtimes (e.g. Cloudflare Workers Free) from decoding costs that can exceed request CPU budgets even when the RGBA buffer fits within the existing 32 MiB memory cap. Dimensions, content hashing, and upload validation are unchanged.

`POST /_emdash/api/media/{id}/confirm` also accepts an optional `thumbnail` object (`{ contentType, data }`, base64-encoded bytes). When provided, the small thumbnail is decoded for the blurhash instead of the full-resolution original, allowing clients to keep LQIP for large images without server-side full decode.

Placeholder generation can now be disabled entirely with the new `imagePlaceholders: false` option in the EmDash config, and it defaults to `false` on Cloudflare Workers (detected via the `@astrojs/cloudflare` adapter) to avoid burning request CPU budgets on full-image decoding. Node and other unconstrained runtimes keep the previous default of `true` for backwards compatibility. Cloudflare sites that use blurhash or dominant-color placeholders can opt back in with `imagePlaceholders: true`. In all cases, dimensions, validation, content hashing, and responsive image variants remain intact.
