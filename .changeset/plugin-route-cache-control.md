---
"emdash": minor
---

Adds a `cacheControl` option for public plugin routes: successful GET responses carry the configured `Cache-Control` header, enabling CDN and browser caching for public plugin endpoints. Private routes and errors keep the `private, no-store` default.
