---
"@emdash-cms/cloudflare": patch
---

Deprecates `cloudflareCache()` (legacy Cache API + zone REST purge). It now emits a one-time console warning and is marked `@deprecated` in types. New sites should use native Workers Caching (`"cache": { "enabled": true }` in wrangler plus `cacheCloudflare()` from `@astrojs/cloudflare/cache`) and purge with `cache.purge()` — no zone ID or Cache Purge API token.
