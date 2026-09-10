---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugin `ctx.kv.set()`, collection `put()`, and `putMany()` writes on Cloudflare D1 to preserve creation timestamps when overwriting keys. Unique constraint conflicts reject the write and retain the existing record. `putMany()` keeps writes completed before a failing item.
