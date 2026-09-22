---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes revision restore on Cloudflare D1 so the restored content and its audit revision commit atomically. If either write fails, the entry and its revision history remain unchanged.
