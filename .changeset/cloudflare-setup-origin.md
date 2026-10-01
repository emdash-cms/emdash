---
"emdash": patch
---

Fixes the setup wizard failing with `SITE_URL_REQUIRED` on Cloudflare Workers since 0.40.1 when `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` is not set, which blocked new sites created with the Deploy to Cloudflare button. On Cloudflare's network, setup now records `https://` and the hostname it runs on as the origin for authentication emails, and passkeys created during setup only work on that hostname.

- To use a custom domain, run setup on that domain or set `EMDASH_SITE_URL` first.
- Node.js deployments still need a configured origin before production setup.
- A Workers build served outside Cloudflare (`wrangler dev`, `astro preview`, or self-hosted workerd) on a reachable address should set `siteUrl` or `EMDASH_SITE_URL` before setup.
