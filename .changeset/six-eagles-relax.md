---
"emdash": patch
---

Fixes OAuth login (Google/GitHub) failing with "Failed to start OAuth flow" on Astro 6+ Cloudflare deployments. The OAuth start and callback routes read provider credentials via `Astro.locals.runtime.env`, which Astro 6 removed — accessing it now throws instead of returning `undefined`, so the existing optional-chaining fallback never ran. Both routes now read Cloudflare bindings through a build-time virtual module instead, falling back to `import.meta.env` on non-Cloudflare adapters exactly as before.
