---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds cold-start caching to reduce database queries from ~20 to ~2 on established sites. Manifest and init data (plugin states, site info) are persisted to the options table and reused across cold starts. A new `wrapWithLazyMigrations()` dialect wrapper defers migration checks until the first schema error, applied to all built-in adapters. FTS verification is skipped on init.
