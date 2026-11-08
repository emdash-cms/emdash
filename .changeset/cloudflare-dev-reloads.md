---
"emdash": patch
"@emdash-cms/plugin-test": patch
---

Pre-bundles admin-route dependencies during Cloudflare `astro dev` on Astro 7 (Vite 8) or later. This does not fix the remaining public-page reload delay.

Prevents a replacement development runtime from initializing while a cached runtime is shutting down.

When upgrading `emdash`, upgrade `@emdash-cms/plugin-test` alongside it so its workerd test setup includes the reload-hook export.
