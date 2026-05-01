---
"emdash": minor
---

Removes the worker-isolate manifest cache and stops loading the manifest on public requests.

The admin manifest (collection schemas, plugins, taxonomies) is built fresh from the live database on every admin request via two queries (`SchemaRegistry.listCollectionsWithFields()`), deduplicated within a single request by `requestCached`. Logged-out / public requests no longer touch it at all — the global middleware no longer pre-loads `locals.emdashManifest`. Admin routes that need it call `await emdash.getManifest()`.

This closes the cross-isolate staleness bug class behind #776, #873, #876, and #877 by elimination: there is no cache to invalidate, so there is nothing to fan out across warm sibling isolates on Cloudflare Workers, and there is nothing to leave stale after a fire-and-forget delete is cancelled at response-time.

**Breaking changes**

- `locals.emdash.invalidateManifest` is removed. The shim that survived earlier was a misnomer once the manifest cache itself was gone. Plugin code that called this after schema changes should switch to `locals.emdash.invalidateUrlPatternCache` (the only side effect that survived) — or drop the call entirely if the mutation didn't affect collection URL patterns (field/taxonomy/plugin mutations don't).
- `locals.emdashManifest` is removed. Read it via `await locals.emdash.getManifest()` instead. The only in-tree consumers were the admin manifest endpoint and the WordPress importer routes, both updated.
- `EmDashRuntime.invalidateManifest()` is removed. `EmDashRuntime.getManifest()` is preserved with the same signature; its body now skips the cache layer.

**Performance**

The admin manifest build is now two queries flat (one for collections, one for the fields of every returned collection) instead of N+1. This is the cost the cache was hiding; with a JOIN-flavoured replacement it's cheap enough to run per request.
