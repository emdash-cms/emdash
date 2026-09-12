---
"emdash": patch
---

Fixes preview links 404ing on sites with a custom collection `url_pattern`. The content Preview button now resolves the collection's `url_pattern` (the same route the sitemap and "View published" links use) instead of the hard-coded `/{collection}/{id}`, falling back to `/{collection}/{id}` only when no pattern is configured. An explicit `pathPattern` or `EMDASH_PREVIEW_PATH_PATTERN` still takes precedence.
