---
"@emdash-cms/cloudflare": patch
---

Fixes `sandbox()` turning off sandboxed plugins in projects that have a `cloudflare.config.ts` (the config file used by `@astrojs/cloudflare` 15). When that file exists in the project root, `sandbox()` now selects the Worker Loader runner without reading any Wrangler config and without requiring `wrangler` to be installed. Add the binding with `LOADER: bindings.workerLoader()` under `worker.env`. If it is missing, EmDash logs a warning when the Worker starts instead of during the build.
