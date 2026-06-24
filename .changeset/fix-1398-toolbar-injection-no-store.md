---
"emdash": patch
---

Fixes the editor toolbar leaking into a shared cache (#1398). When a logged-in editor browsed the public site behind a shared cache (such as Cloudflare), responses carrying the injected toolbar could be cached and then served to anonymous visitors, exposing the toolbar markup and the fact that a session was active. Toolbar-bearing responses are now marked `Cache-Control: private, no-store` so they are never shared-cacheable; responses without an injected toolbar keep their original caching.
