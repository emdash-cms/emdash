---
"emdash": patch
---

Fix an issue where the redirect middleware would rerun a route and hide the original error when the route (or later middleware) threw. The catch block is now narrowed to the redirect lookup, so `next()` is called exactly once and route errors propagate to Astro. Failures during the middleware's own post-response work (404 logging and cache handling) are still caught and logged rather than propagated.
