---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes registry and marketplace plugin routes intermittently returning `404 Plugin route not found` on warm Cloudflare isolates after an install, update, or uninstall. Requests to `/_emdash/api/plugins/*` check for plugin-state changes before checking route permissions, without requiring a redeploy. Only newer generation-tagged snapshots are applied, so replica lag can delay a change but cannot restore older plugin code or permissions.

Plugin route requests return `503 PLUGIN_SYNC_ERROR` if state cannot be read or the requested plugin fails to load. Bundle and sandbox-load failures retry after a five-second backoff, or immediately when the plugin's stored state changes.

On Durable Object SQL deployments, upgrade core and the Cloudflare adapter together so plugin state and its generation are committed atomically.

Durable Object SQL also executes existing atomic batches for content saves, menus, seeding and block-type updates as single primary transactions instead of separate statements.
