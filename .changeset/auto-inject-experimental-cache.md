---
"emdash": patch
---

Fixes a runtime crash where API routes (publish, unpublish, schedule) and templates (`Astro.cache.set`) hit `Cannot read properties of undefined` when the host project hadn't opted into Astro's `experimental.cache`. The integration now auto-injects `memoryCache()` as the default provider; hosts that already configured a provider keep theirs.
