---
"@emdash-cms/cloudflare": patch
---

Documents that `cloudflareCache()` is the legacy Cache API + zone REST purge path. New sites should use native Workers Caching (`"cache": { "enabled": true }` in wrangler plus `cacheCloudflare()` from `@astrojs/cloudflare/cache`) and purge with `cache.purge()` — no zone ID or Cache Purge API token.
