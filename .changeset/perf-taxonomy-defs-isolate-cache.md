---
"emdash": patch
---

Cut per-render D1 round trips on public pages by caching taxonomy definitions across the worker isolate, and harden the runtime/DB singletons against bundler module duplication.

Every public render that hydrates entry terms read `SELECT * FROM _emdash_taxonomy_defs` (via `getTaxonomyDefs` → `getCollectionTaxonomyNames`), which only had per-request caching. On Cloudflare D1, where the worker colo is often far from the database primary, each query is a ~40ms cross-region round trip, so this fired on every warm request for no benefit — taxonomy _definitions_ change extremely rarely (created via the admin API or a seed; there is no edit/delete-def path). They're now cached per-isolate behind a `globalThis` Symbol holder (the same two-tier pattern as `settings/index.ts` and the byline field-defs cache), keyed by resolved locale and invalidated in-memory by every def write (`handleTaxonomyCreate`, seed application). Invalidation is in-memory rather than a persisted version probe on purpose: a per-request version read would merely replace the query being removed, yielding no net saving on warm isolates. Isolated databases (playground / DO preview) bypass the cache.

Separately, the cached runtime instance, the DB-instance cache, and the in-flight DB-init promise (`astro/middleware.ts`, `emdash-runtime.ts`) were plain module-scoped variables. Under Vite SSR chunk duplication those can become multiple independent copies, letting cold-start migrations and bootstrap reads re-run on requests that should have hit the warm cache. They now live on `globalThis` behind Symbol keys, matching the existing `SETUP_VERIFIED_KEY` / request-context / request-cache singletons.

No schema changes, no public API changes, fully backwards compatible.
