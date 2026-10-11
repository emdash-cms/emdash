---
"emdash": patch
---

Fixes creating content without a `slug` on Cloudflare D1 when the slug derived from the title is already taken and 49 characters or longer. The request failed with a 500 `CONTENT_CREATE_ERROR` (`LIKE or GLOB pattern too complex` in the log) instead of getting a numeric suffix. Duplicating such an entry and generating taxonomy term slugs from long names are fixed the same way.
