---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes media stored in R2 or local storage being served as full-size originals in production when `siteUrl` isn't set in `astro.config.mjs` and `EMDASH_SITE_URL` isn't set at build time, as in the Cloudflare templates. On pages rendered on demand, the `Image` and `Gallery` components from `emdash/ui` now get resized WebP renditions and a responsive `srcset` without extra configuration, through the Cloudflare Images binding with the Cloudflare adapter's default image service, or through sharp on Node. On Node without `sharp` installed, these images are served as the original file instead of failing.
