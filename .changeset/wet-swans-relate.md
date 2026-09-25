---
"@emdash-cms/cloudflare": patch
---

Fixes `ctx.kv.set()` and storage collection `put()` and `putMany()` writes for sandboxed plugins on Cloudflare. Overwrites retain creation timestamps, and unique constraint failures preserve existing records.
