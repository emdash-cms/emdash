---
"emdash": patch
---

Fixes Cloudflare development servers failing during cold start with Astro 7.3.1 after Vite discovers `astro/logger/console` and invalidates prebundled server chunks.
