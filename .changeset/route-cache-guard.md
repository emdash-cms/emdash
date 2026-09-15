---
"emdash": patch
---

Fixes pages failing with `TypeError: Cannot read properties of undefined (reading 'set')` when a preview link, an `_edit` link or a signed-in editor reaches a response Astro renders without a route-cache handle, such as the 404 page for a URL that matches no route. EmDash's middleware now skips the route-cache opt-out when there is no cache handle instead of throwing.
