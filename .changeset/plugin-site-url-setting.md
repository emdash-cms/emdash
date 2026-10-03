---
"emdash": patch
---

Fixes plugins seeing an outdated site address in `ctx.site.url` and `ctx.url()`. They now use the same origin as links in emails: the configured `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL`, then the **Site URL** from **Settings > General**, then the address the site was set up on. Previously plugins only saw the setup address, even when `siteUrl` was configured or the site had moved to a new domain. A changed **Site URL** reaches plugins after the server restarts or, on Cloudflare Workers, as new isolates start.
