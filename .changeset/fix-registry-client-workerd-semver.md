---
"@emdash-cms/registry-client": patch
"emdash": patch
---

Fix `require is not defined` crash on every EmDash API route under `astro dev` on Cloudflare Workers (#1292).

`@emdash-cms/registry-client` listed `semver` (CommonJS) in `dependencies`, which the build externalizes -- so consumers loaded a nested CJS copy. Vite's SSR module runner (workerd) evaluates modules with no `require` binding, so semver's internal `require()` threw and took down any route whose import graph reached registry-client (schema, plugins, env compatibility checks). semver is now bundled into the ESM output, so nothing CommonJS reaches the worker.
