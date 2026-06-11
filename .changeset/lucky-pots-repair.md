---
"emdash": patch
---

Removes three query waterfalls on content-site renders:

- `getTerm()` now runs its usage-count and children queries concurrently, saving a round trip on every tag/category archive page.
- `getMenu()` request-caches the collection `url_pattern` lookup, so pages rendering several menus (header, footer, ...) only pay for it once per request.
- Generated collection types (`emdash-env.d.ts`) now include the `terms` field that `getEmDashEntry`/`getEmDashCollection` already hydrate, so templates can read `entry.data.terms?.tag` instead of issuing a redundant `getEntryTerms()` query. The bundled templates and demos have been updated to do so.
