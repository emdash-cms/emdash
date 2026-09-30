---
"emdash": patch
---

Fixes pages that answer a missing entry with `Astro.rewrite("/404")`: the visual editing toolbar (and the client toolbar script) now appears once instead of twice, and the 404 response is kept out of the route cache, so the URL starts working as soon as the entry is published.
