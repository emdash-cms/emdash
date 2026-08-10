---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes anonymous public pages reseeding edge/object caches with stale Hyperdrive query results right after content publishes. When `cachedBinding` and a distributed Object Cache are configured, public reads across Worker isolates prefer the uncached Hyperdrive binding for a short window after content writes (default 60s, overridable via `preferUncachedAfterWriteMs` to match your Hyperdrive max_age).
