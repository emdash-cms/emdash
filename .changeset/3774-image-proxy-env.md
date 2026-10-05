---
"emdash": patch
---

Fixes locally stored images being served as unoptimized originals on sites that set their public origin with `EMDASH_SITE_URL` or `SITE_URL` instead of `siteUrl`, such as Node.js deployments behind an HTTPS reverse proxy. The variable must be set when `astro build` runs; a value set only in the runtime environment does not enable image optimization.
