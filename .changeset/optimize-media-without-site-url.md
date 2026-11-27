---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes media served through EmDash's media route (R2 or local storage without a public bucket URL) being served as full-size originals in production when `siteUrl` isn't set in `astro.config.mjs` and neither `EMDASH_SITE_URL` nor `SITE_URL` is set at build time, as in the Cloudflare templates. On pages rendered on demand, the `Image` and `Gallery` components from `emdash/ui` now get resized WebP renditions and a responsive `srcset` without extra configuration, through the Cloudflare Images binding with the Cloudflare adapter's default image service, or through sharp on Node. Prerendered pages still need `siteUrl`, `EMDASH_SITE_URL` or `SITE_URL` when `astro build` runs. These images are served as the original file instead of failing when the Cloudflare Images binding returns an error, for example after the plan's monthly transformations run out, or on Node without `sharp` installed.
