---
"emdash": patch
---

Fixes repeated `getEmDashEntry()` calls with the same arguments issuing duplicate database reads within a request, so layouts and blocks can share a singleton entry read.
