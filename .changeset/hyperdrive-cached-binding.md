---
"@emdash-cms/cloudflare": minor
---

Adds an optional `cachedBinding` to the `hyperdrive()` adapter for serving anonymous reads from a caching-enabled Hyperdrive configuration. When set, anonymous read requests route through the cache-enabled binding while every authenticated request and every write stays on the primary (caching-disabled) `binding`, preserving read-after-write consistency. Bind both Hyperdrive configurations in wrangler and pass `hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" })`. Omitting `cachedBinding` leaves behavior unchanged.
