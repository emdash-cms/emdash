---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes plugin `ctx.storage.<collection>.getMany()` and `deleteMany()` failing on D1 with `too many SQL variables` when passed more than 98 ids. Both now accept any number of ids, in trusted and sandboxed plugins alike.
