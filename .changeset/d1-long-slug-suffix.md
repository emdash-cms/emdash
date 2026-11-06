---
"emdash": patch
---

Fixes generating a taxonomy term slug on Cloudflare D1 when the slug derived from the term's name is already taken and 49 characters or longer. The lookup failed with `LIKE or GLOB pattern too complex` instead of adding a numeric suffix.
