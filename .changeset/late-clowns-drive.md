---
"emdash": patch
---

Fixes content creation on Cloudflare D1 when a long generated slug is already taken, allowing repeated titles to receive numeric slug suffixes instead of failing with `CONTENT_CREATE_ERROR`.
