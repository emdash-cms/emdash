---
"emdash": patch
---

Fixes the Recent Posts widget linking to `/posts/{id}` (a 404 with the default slug-based routes) — links now use the post slug. Adds an optional `urlTemplate` prop (e.g. `"/blog/:slug"`) for sites with custom or catch-all routing, matching the LiveSearch `routeMap` template tokens.
