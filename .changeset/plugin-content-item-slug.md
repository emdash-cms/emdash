---
"emdash": patch
---

Adds `slug` and `status` to `ContentItem` in the plugin content API. `ctx.content.get()` / `ctx.content.list()` now surface these fields so plugins can match content items by slug and filter by publication status without re-querying the database.
