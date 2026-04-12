---
"emdash": patch
---

Fixes `ctx.content.create()` and `ctx.content.update()` so plugins can write
to the core SEO panel. When the input `data` contains a reserved `seo` key,
it is now extracted and routed to `_emdash_seo` via the SEO repository,
matching the REST API shape. `ctx.content.get()` and `ctx.content.list()`
also hydrate the `seo` field on returned items for SEO-enabled collections.
