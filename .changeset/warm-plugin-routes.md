---
"emdash": patch
---

Fixes registry and marketplace plugin API routes returning stale results on warm Cloudflare Workers isolates after an install, update, or uninstall. Plugin API requests now refresh installed plugins before checking route permissions, without requiring a redeploy.
