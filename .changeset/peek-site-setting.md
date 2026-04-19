---
"emdash": patch
---

`getSiteSetting(key)` now transparently piggybacks on `getSiteSettings()` when the batch has already been loaded in the current request. If a parent template has called `getSiteSettings()` (which is request-cached), a later `getSiteSetting("seo")` — from `EmDashHead`, a plugin, or user code — reads the key from that cached result instead of firing its own round-trip. Falls back to a per-key cached query when nothing has been primed.

Exposes `peekRequestCache(key)` for internal use by other helpers that want the same "read from a broader cached query if available" pattern.

On the blog-demo fixture: the SEO call added in PR #613 now costs zero extra queries per page (it reads from the Base layout's existing `getSiteSettings()` result).
