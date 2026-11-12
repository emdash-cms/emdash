---
"emdash": patch
---

Fixes two Astro warnings on static sites: the `Astro.request.headers` warning on prerendered pages and the `cache.set()` warning on 404s when no route cache provider is configured.
