---
"emdash": minor
"@emdash-cms/plugin-types": minor
---

Adds a `cacheControl` option for public plugin routes: successful GET responses carry the configured `Cache-Control` header, enabling CDN and browser caching for public plugin endpoints. Works for native, standard, and marketplace plugin formats. Private routes and errors keep the `private, no-store` default.
