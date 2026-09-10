---
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed `ctx.content.create()` accepting `author_id` and `primary_byline_id` from plugin data on Cloudflare and Workerd. Those values are ignored during creation, and sandboxed reads omit the raw `primary_byline_id` field from `item.data`.
