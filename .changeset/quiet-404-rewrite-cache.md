---
"emdash": patch
---

Fixes repeated layout queries when anonymous public pages use `Astro.rewrite("/404")`. Rewritten pages with the same locale and rendering policy reuse the request cache and prefetched layout data instead of opening a second database scope.
