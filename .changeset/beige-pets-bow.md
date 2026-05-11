---
"emdash": patch
---

Fixes TypeError crash on all content mutation API routes when Astro's cache API is not available. The `cache` context parameter is undefined when the cache feature is not enabled, causing `cache.enabled` to throw. All 11 call sites now use optional chaining (`cache?.enabled`).
