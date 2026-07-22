---
"emdash": minor
---

Adds collection schema lookup and slug generation to the plugin content API. `ctx.content.getCollection(slug)` returns a collection definition with its fields, and `ctx.content.create` now derives a unique slug the same way the admin and REST create paths do — from a reserved `slug` key when provided, falling back to the entry's `title` or `name` field. Entries are also created in the site's configured default locale instead of always `en`. Previously, plugin-created entries always had a null slug.
