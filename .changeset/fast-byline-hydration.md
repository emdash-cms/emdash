---
"emdash": patch
---

Removes a separate schema-version query when `getEmDashEntry()` and `getEmDashCollection()` render bylines, saving a round trip to D1 and other remote databases. Changes to custom byline fields remain visible across server instances on the next request.
