---
"emdash": patch
---

Fixes the redirect middleware so it no longer reruns a route or swallows the original error when the route (or later middleware) throws. Errors thrown after the redirect lookup now propagate to Astro as expected.
