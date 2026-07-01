---
"emdash": patch
---

Fixes statically-sandboxed plugins (registered via `sandboxed: []` in `astro.config.mjs`) being absent from the admin Plugins screen. They are now listed alongside trusted and marketplace plugins, and can be fetched, enabled, and disabled through the same plugin management API.
