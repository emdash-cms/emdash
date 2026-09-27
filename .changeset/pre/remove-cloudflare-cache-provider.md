---
"@emdash-cms/cloudflare": patch
---

Removes the deprecated `cloudflareCache()` route-cache provider and its `@emdash-cms/cloudflare/cache` and `@emdash-cms/cloudflare/cache/config` entry points. Sites that still import `cloudflareCache` fail to build after upgrading.

Switch to native Workers Caching with the Astro Cloudflare adapter's provider. The adapter enables Workers Cache in the generated deployment configuration when this provider is set:

```diff title="astro.config.mjs"
- import { cloudflareCache } from "@emdash-cms/cloudflare";
+ import { cacheCloudflare } from "@astrojs/cloudflare/cache";

 export default defineConfig({
 	cache: {
-		provider: cloudflareCache(),
+		provider: cacheCloudflare(),
 	},
 });
```

Invalidation moves to `cache.purge()` from `cloudflare:workers`, so the `CF_ZONE_ID` and `CF_CACHE_PURGE_TOKEN` secrets are no longer needed and can be deleted. The KV object cache (`kvCache()` and `@emdash-cms/cloudflare/cache/kv`) is unchanged.
