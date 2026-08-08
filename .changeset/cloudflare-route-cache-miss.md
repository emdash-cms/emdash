---
"@emdash-cms/cloudflare": patch
---

Return route-cache miss responses before Cloudflare Cache API writes finish.

The Cloudflare cache provider now schedules MISS response storage with `waitUntil()`
instead of awaiting `cache.put()` before returning the rendered page. This prevents
slow or stalled edge cache writes from blocking otherwise valid visitor responses.
