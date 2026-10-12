---
"emdash": patch
---

Fixes `media:afterUpload` hooks being silently dropped for REST API multipart uploads and MCP `media_create` uploads on Cloudflare Workers. Both upload paths now defer hook execution through `after()`, matching the admin confirm flow so hooks that perform async work complete as expected.
