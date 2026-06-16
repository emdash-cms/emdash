---
"emdash": patch
---

Fixes admin pages hanging indefinitely (and eventually returning 524 timeouts) on Cloudflare Workers. The worker-lifetime caches for site settings and search-index health could be left holding a request that never completed (for example when a visitor's request was cancelled mid-load), which then stalled every later request served by that worker until it was recycled. These caches now keep resolved values rather than in-flight requests, so a cancelled or interrupted request can no longer wedge the rest.
