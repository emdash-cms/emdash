---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Add an optional distributed object cache for query results.

Content reads (`getEmDashCollection`, `getEmDashEntry`, `resolveEmDashPath`) and chrome reads (site settings, menus, taxonomies) can now be served from a fast key/value store instead of hitting the database on every request. This sits beneath the per-request cache and above the database, dramatically reducing read pressure on D1/SQLite — especially valuable on Cloudflare, where KV handles far more requests than D1.

The cache is **off by default** and fully opt-in. Configure a backend in `astro.config.mjs`:

```ts
import { kvCache } from "@emdash-cms/cloudflare"; // Workers KV (distributed)
import { memoryCache } from "emdash/astro"; // in-isolate (Node / local dev)

emdash({
	database: d1({ binding: "DB" }),
	objectCache: kvCache({ binding: "CACHE" }),
});
```

with a matching KV binding in `wrangler.jsonc`:

```jsonc
{ "kv_namespaces": [{ "binding": "CACHE", "id": "<namespace-id>" }] }
```

Invalidation is epoch-based and automatic: content, byline, taxonomy, menu, and settings writes bump a per-namespace version, instantly orphaning stale entries (no key enumeration needed). Authenticated, preview, and visual-edit requests always bypass the cache, so editors see live content immediately; anonymous visitors may see content up to `revalidate` ms stale after an edit (default 1s, configurable).

New public API: `cachedQuery`, `invalidateObjectCache`, `invalidateCollectionCache`, `contentNamespace`/`contentNamespaces`, `CacheNamespace`, the `ObjectCache*` types (from `emdash`), `memoryCache()` (from `emdash/astro`), and `kvCache()` (from `@emdash-cms/cloudflare`). Existing sites are unaffected until they opt in.
