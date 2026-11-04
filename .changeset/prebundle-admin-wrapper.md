---
"emdash": patch
---

Fixes `astro dev` reloading the admin on the first visit after a cold start. Plugin admin pages that import `emdash/plugin-utils` no longer load against stale pre-bundled modules from before the reload.
