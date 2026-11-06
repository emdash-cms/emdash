---
"emdash": patch
---

Improves page-edit reload times in Cloudflare `astro dev` projects by pre-bundling the EmDash runtime. Development reloads also retire the cached runtime so content writes do not reference dependency chunks replaced by Vite.
