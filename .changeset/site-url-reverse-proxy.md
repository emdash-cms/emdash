---
"emdash": minor
---

Adds `siteUrl` config option to fix reverse-proxy origin mismatch. Replaces `passkeyPublicOrigin` with a single setting that covers all origin-dependent features: passkeys, CSRF, OAuth, auth redirects, MCP discovery, snapshots, sitemap, robots.txt, and JSON-LD.

Supports `EMDASH_SITE_URL` / `SITE_URL` environment variables for container deployments where the domain is only known at runtime.

Disables Astro's `security.checkOrigin` (EmDash's own CSRF layer handles origin validation with dual-origin support and runtime siteUrl resolution). When `siteUrl` is set in config, also sets `security.allowedDomains` so `Astro.url` reflects the public origin in templates.

**Breaking:** `passkeyPublicOrigin` is removed. Rename to `siteUrl` in your `astro.config.mjs`.
