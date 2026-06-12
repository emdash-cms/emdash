---
"emdash": minor
---

Generate responsive `srcset`s for media rendered with the `Image` and Portable Text image components. EmDash now routes locally/R2-stored media through Astro's configured image service (`astro:assets`) -- the Cloudflare Images binding on Workers, sharp on Node -- producing width-appropriate candidates and modern formats (e.g. WebP) instead of a single full-size `<img>`.

This works automatically:

- Media served from a configured storage `publicUrl` (R2 custom domain, S3/CDN) is authorized and optimized.
- Same-origin proxied media (local storage, or R2 without a public URL) is optimized when `siteUrl` is set; the matching `image.remotePatterns` entry is registered for you, scoped to the media route.
- In `astro dev` it works out of the box without configuration.

When optimization isn't possible (no image service available, an unauthorized host, or unknown dimensions) the components fall back to a plain `<img>`, so existing sites keep rendering exactly as before. No template changes are required.
