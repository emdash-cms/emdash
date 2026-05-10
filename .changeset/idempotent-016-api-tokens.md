---
"emdash": patch
---

Fixes migration `016_api_tokens` failing with `table "_emdash_api_tokens" already exists` after a partially-applied previous attempt. If `up()` crashed mid-way (D1 subrequest limit, isolate cancellation, transient connection error), the migration record never got recorded and Kysely re-ran the migration from the top on the next request, blocking every subsequent boot. `up()` now uses `IF NOT EXISTS` on every CREATE so a retry skips already-applied steps and finishes the remainder. Resolves the "table already exists" error reported on fresh Cloudflare Workers + D1 deploys.
