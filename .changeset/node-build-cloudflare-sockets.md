---
"emdash": patch
---

Fixes `astro build` failing with `Rollup failed to resolve import "cloudflare:sockets"` on Astro 6 sites that use `@astrojs/node` or another non-Cloudflare adapter, so the `vite.build.rollupOptions.external: [/^cloudflare:/]` workaround is no longer needed.
