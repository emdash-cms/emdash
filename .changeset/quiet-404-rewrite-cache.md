---
"emdash": patch
---

Fixes duplicate layout queries when anonymous public pages call `Astro.rewrite()`, such as rewriting an unknown slug to `/404`. The rewritten page reuses the original request's cached reads and prefetched layout data. Previews, edit mode, and requests carrying session cookies or authorization headers continue to use fresh request contexts.
