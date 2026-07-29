---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": patch
"@emdash-cms/blocks": minor
---

Adds an admin API to purge the CMS object cache (`GET`/`POST /_emdash/api/admin/cache/object`) and a `cache:purge` plugin capability so sandboxed plugins can clear KV/memory object-cache namespaces via `ctx.cache`. Block Kit buttons also support optional `disabled` and `title` (tooltip) fields.
