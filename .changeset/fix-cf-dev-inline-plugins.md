---
"emdash": patch
---

Stop the `astro dev` dependency-optimize reload cascade on Cloudflare for npm-installed sites. EmDash core, the Cloudflare adapter (`@emdash-cms/cloudflare`), and configured plugins are now transformed inline by Vite in dev instead of being pre-bundled one subpath at a time.

Plugins and the adapter expose many subpath exports (`emdash/middleware`, `@emdash-cms/cloudflare/db/d1`, `<plugin>/astro`, ...) and plugins often ship TypeScript source. On a registry install the dev dep-optimizer discovered these lazily on the first request to each route, invalidating the optimize cache mid-flight (`The file does not exist at ".../deps_ssr/chunk-*.js"`) and forcing repeated full reloads on cold start. Plugin package names are derived from their descriptors, so third-party plugins are covered automatically. Workspace/monorepo setups were unaffected, which is why this only reproduced in standalone projects.
