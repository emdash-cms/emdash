---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": patch
"@emdash-cms/blocks": minor
---

Adds admin APIs and a `cache:purge` plugin capability for clearing CMS caches: object cache (`GET`/`POST /_emdash/api/admin/cache/object`, `ctx.cache.purgeObjectCache`) and native Workers Caching (`GET`/`POST /_emdash/api/admin/cache/workers`, `ctx.cache.purgeWorkersCache` via `cache.purge` — purge everything or path prefixes; no zone ID or API token). Block Kit buttons also support optional `disabled` and `title` (tooltip) fields.
