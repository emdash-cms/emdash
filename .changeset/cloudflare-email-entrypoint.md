---
"@emdash-cms/cloudflare": patch
---

Fixes `cloudflareEmail()` failing the Astro build. It now returns a plugin descriptor with a bundlable entrypoint instead of an in-process plugin definition, so the documented `plugins: [cloudflareEmail({...})]` usage builds again.
