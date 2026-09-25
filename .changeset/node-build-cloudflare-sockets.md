---
"emdash": patch
---

Fixes `astro build` failing with `Rollup failed to resolve import "cloudflare:sockets"` on Astro 6 sites that use `@astrojs/node` or another non-Cloudflare adapter, so EmDash's own import no longer needs a `vite.build.rollupOptions.external: [/^cloudflare:/]` workaround.
