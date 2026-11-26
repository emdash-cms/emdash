---
"emdash": patch
---

Fixes `decodeSlug()` so a slug containing a NUL byte (for example `/posts/%00`) returns `undefined`. On PostgreSQL, routes that decode their slug with it now show their 404 for such URLs instead of failing the content query with a 500.
