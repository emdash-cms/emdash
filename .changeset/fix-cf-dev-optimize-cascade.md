---
"emdash": patch
---

Pre-bundle EmDash's auth, MCP, and admin-shell dependencies so `astro dev` on Cloudflare no longer triggers a re-optimize + full-reload cascade on the first authenticated/admin/MCP request.

These deps (`@oslojs/crypto/{hmac,subtle,rsa}`, `arctic`, the MCP server entrypoints, `@lingui/react`, `@cloudflare/kumo/primitives`, `astro/assets/services/noop`) are only imported on routes the initial Vite scan never reaches, so the workerd runtime discovered them one at a time. Each discovery invalidated the optimize cache mid-flight, producing `The file does not exist at ".../deps_ssr/chunk-*.js"` errors and repeated full reloads on cold start. Adding them to the Cloudflare SSR `optimizeDeps.include` list front-loads them into a single startup optimize pass.
