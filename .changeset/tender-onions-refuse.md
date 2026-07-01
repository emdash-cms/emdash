---
"emdash": patch
---

Fixes MCP tools and content writes failing in Cloudflare dev servers with `The file does not exist at ".../deps_ssr/..."` after Vite re-optimizes dependencies, which previously required a dev server restart. Also pre-bundles the migration runner, image transform endpoint, and `astro/zod` so the first setup, image, or content request no longer triggers a mid-session re-optimization and worker reload.
