---
"emdash": patch
---

Fixes Cloudflare Workers requests hanging indefinitely after another request is cancelled while the object cache backend is loading. A timed-out request now bypasses the cache and loads the requested data directly, while later requests can initialize the cache again.
