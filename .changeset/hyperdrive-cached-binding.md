---
"@emdash-cms/cloudflare": minor
---

Adds an optional `cachedBinding` to the `hyperdrive()` adapter for serving anonymous public-site reads from a caching-enabled Hyperdrive configuration. When set, anonymous reads of public paths route through the cache-enabled binding, while every authenticated request, every write, and every request under `/_emdash` (admin, setup, auth, internal APIs) stays on the primary (caching-disabled) `binding` — preserving read-after-write consistency, including for the anonymous post-setup status check. Bind both Hyperdrive configurations in wrangler and pass `hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" })`. Omitting `cachedBinding` leaves behavior unchanged.
