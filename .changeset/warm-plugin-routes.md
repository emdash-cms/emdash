---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes registry and marketplace plugin API routes returning stale results on warm Cloudflare Workers isolates after an install, update, or uninstall. Plugin API requests now refresh installed plugins before checking route permissions, without requiring a redeploy. With D1 read replication enabled, installed-plugin requests use a primary-first session so a lagging replica cannot restore an older plugin version or its route permissions.

Plugin API requests return `503 PLUGIN_SYNC_ERROR` if the requested plugin's state or bundle cannot be read, or the plugin fails to load in its sandbox. Bundle and sandbox-load failures retry after a five-second backoff, or immediately when the plugin's stored state changes.

Upgrade `emdash` and `@emdash-cms/cloudflare` together for this fix.
