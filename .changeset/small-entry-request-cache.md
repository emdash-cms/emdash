---
"emdash": patch
---

Fixes repeated `getEmDashEntry()` calls with the same arguments issuing duplicate database reads within a request, so layouts and blocks can share a singleton entry read. As with `getEmDashCollection()`, identical calls in one request now share the same result object, so copy entry data before modifying it.
