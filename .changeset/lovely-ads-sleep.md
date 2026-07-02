---
"emdash": patch
---

Fixes GitHub/Google OAuth login when using `@astrojs/cloudflare` v13+ (Astro v6). The `@astrojs/cloudflare` adapter removed `locals.runtime.env` in Astro v6; the OAuth initiation and callback routes now fall back to `cloudflare:workers` env when `locals.runtime.env` throws, then to `import.meta.env` for Node.js environments.
