---
"emdash": patch
---

Fixes MCP OAuth discovery advertising `http://` URLs on Cloudflare and other proxied deployments. The `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` routes now honor `siteUrl` on anonymous requests, so MCP clients can attach without setting `EMDASH_SITE_URL` as an env var.
