---
"emdash": patch
---

Pre-bundle runtime-reached SSR deps (middleware chain, lazy Cloudflare adapter entrypoints, `emdash/ui`, `emdash/runtime`, `astro/zod`) in the Cloudflare branch of `ssr.optimizeDeps.include`. Without these the cold Vite dev cache discovered them at request time and could cascade a `deps_ssr` re-optimize race that crashed the first SSR requests.
