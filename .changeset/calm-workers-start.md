---
"emdash": patch
---

Fixes fresh Cloudflare projects failing to start `astro dev` with a missing `node_modules/.vite/deps_ssr` file when Vite discovers `astro/app/manifest` after startup.
