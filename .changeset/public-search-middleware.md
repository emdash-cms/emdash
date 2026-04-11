---
"emdash": patch
---

Fixes public access to the search API (#104). The auth middleware blocked `/_emdash/api/search` before the handler ran, so #107's handler-level change never took effect for anonymous callers. Adds the endpoint to `PUBLIC_API_EXACT` so the shipped `LiveSearch` component works on public sites without credentials. Admin endpoints (`/search/enable`, `/search/rebuild`, `/search/stats`, `/search/suggest`) remain authenticated.
