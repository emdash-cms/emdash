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

Invalidation is epoch-based and automatic: content, byline, taxonomy, menu, and settings writes bump a per-namespace version, instantly orphaning stale entries (no key enumeration needed). Preview and visual-edit requests bypass the cache, so editors previewing see live content; other reads are served from the cache, which only ever stores published content. After an edit, anonymous visitors may see stale content until isolates pick up the bumped epoch — immediate on the in-isolate memory backend, and on KV bounded by KV's edge-cache propagation (eventually consistent, up to ~60s) plus the `revalidate` window (default 1s, configurable).

New public API: `cachedQuery`, `invalidateObjectCache`, `invalidateCollectionCache`, `contentNamespace`/`contentNamespaces`, `CacheNamespace`, the `ObjectCache*` types (from `emdash`), `memoryCache()` (from `emdash/astro`), and `kvCache()` (from `@emdash-cms/cloudflare`). Existing sites are unaffected until they opt in.
