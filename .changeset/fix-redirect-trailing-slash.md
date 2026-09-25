---
"emdash": patch
---

Fixes slug-change auto-redirects so they keep a trailing slash from the collection's `urlPattern`, and treats `/a` and `/a/` as equivalent when collapsing redirect chains, removing shadow redirects, and checking for an existing source.
