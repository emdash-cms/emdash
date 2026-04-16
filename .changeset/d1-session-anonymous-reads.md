---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes D1 read replicas being bypassed for anonymous public page traffic. The middleware fast path now asks the database adapter for a per-request scoped Kysely, so anonymous reads land on the nearest replica instead of the primary-pinned singleton binding.

All D1-specific semantics (Sessions API, constraint selection, bookmark cookie) live in `@emdash-cms/cloudflare/db/d1` behind a single `createRequestScopedDb(opts)` function. Core middleware has no D1-specific logic. Adapters opt in via a new `supportsRequestScope: boolean` flag on `DatabaseDescriptor`; `d1()` sets it to true.

Other fixes in the same change:

- Nested `runWithContext` calls in the request-context middleware now merge the parent context instead of replacing it, so an outer per-request db override is preserved through edit/preview flows.
- Baseline security headers now forward Astro's cookie symbol across the response clone so `cookies.set()` calls in middleware survive.
- Any write (authenticated or anonymous) now forces `first-primary`, so an anonymous form/comment POST isn't racing across replicas.
- The session user is read once per request and reused in both the fast path and the full runtime init (previously read twice on authenticated public-page traffic).
- Bookmark cookies are validated only for length (≤1024) and absence of control characters — no stricter shape check, so a future D1 bookmark format change won't silently degrade consistency.
- The `!config` bail-out now still applies baseline security headers.
- `__ec_d1_bookmark` references aligned to `__em_d1_bookmark` across runtime, docs, and JSDoc.
