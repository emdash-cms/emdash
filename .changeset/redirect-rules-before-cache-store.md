---
"emdash": patch
---

Fixes Astro's route cache, such as Workers Cache, storing a page at a redirect's source after the redirect was saved. A Worker isolate that had not yet reloaded its redirect rules could render the old page and the route cache kept it, even after the cached page was purged. Before the route cache stores a response, the redirect middleware now checks that its rules are current and answers with the redirect when they have changed. This costs one database read for each response the route cache stores; other responses are unchanged.
