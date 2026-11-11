---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes `ctx.content.delete()` in sandboxed plugins, on Cloudflare and with `@emdash-cms/sandbox-workerd`, so it moves entries to Trash as the admin does. Sites with an `objectCache` no longer keep serving the trashed entry from the cache, and the entry's `updated_at` and `_rev` no longer change.
