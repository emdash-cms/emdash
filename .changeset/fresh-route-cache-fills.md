---
"emdash": patch
---

Fixes Astro route-cache fills rebuilding purged pages from stale object-cache data on Cloudflare KV. Anonymous cache fills now read from the database, while edge-cache hits continue to avoid the Worker. Content cache reads also stop fetching the retired legacy epoch, reducing KV reads while current publishers keep invalidating older rolling-deploy readers.
