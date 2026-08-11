---
"emdash": patch
---

Fixes outbound email links (magic link, invites, signup confirmation, account recovery, comment notifications) ignoring the configured `siteUrl`. The configured origin — `siteUrl` in the integration options or the `EMDASH_SITE_URL`/`SITE_URL` environment variables — now takes precedence over the origin stored during setup, so a site set up on a temporary domain no longer needs a manual database edit to correct its email links.
