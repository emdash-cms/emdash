---
"emdash": patch
---

Fixes object-cache page-render failures on Cloudflare Workers after a request is cancelled. Deferred work now uses Workers' lifetime extender even with injected or vendored Astro adapters, such as Alchemy, and shared cache operations that reject after their owning request ends use their existing non-fatal fallbacks instead of failing the render. Node deployments keep the existing fire-and-forget behavior.
