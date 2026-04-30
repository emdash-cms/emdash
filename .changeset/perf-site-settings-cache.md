---
"emdash": patch
---

Caches the `site:*` settings prefix-scan across requests within a worker isolate. Site settings change rarely; reading them once per route was wasted work. Writes via `setSiteSettings()` invalidate the cache so other isolates pick up changes within their lifetime.
