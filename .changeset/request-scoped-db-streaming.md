---
"emdash": patch
---

Fixes request-scoped database adapters that hold a real connection (e.g. Postgres over Cloudflare Hyperdrive) so they work on Workers. `locals.emdash.db` is now resolved lazily, so routes get the per-request connection instead of a snapshot of the shared singleton, and a request-scoped connection is now closed only after the response body finishes streaming rather than before — Astro streams HTML while components still query, so closing earlier broke server-rendered pages. No effect on D1 or other stateless bindings.
