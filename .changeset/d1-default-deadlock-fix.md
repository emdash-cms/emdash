---
"@emdash-cms/cloudflare": patch
---

Fixes a site-wide hang on Cloudflare Workers with the default D1 config (`d1({ binding: "DB" })`, sessions disabled). Previously, a single request canceled while a D1 query was in flight could deadlock every subsequent D1 query on that Worker isolate — including EmDash's own per-request middleware — so all SSR pages hung until the isolate was recycled. Concurrent D1 queries on the default raw binding now run independently instead of being serialized behind a connection mutex, removing the deadlock.
