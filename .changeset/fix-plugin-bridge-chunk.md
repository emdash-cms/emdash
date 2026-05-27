---
"@emdash-cms/cloudflare": patch
---

Fix config-based sandboxed plugins never loading because `PluginBridge` was `null` via `cloudflare:workers` exports.

**Root cause:** `runner.ts` imported `setEmailSendCallback` directly from `bridge.ts`. This caused `bridge.ts` to be shared between the worker entry path and the runtime/middleware path, so Rollup bundled it into a shared chunk. The resulting `entry.mjs` had `export { bf as PluginBridge }` (a re-export from a chunk) rather than an inline class definition. Cloudflare's `import { exports } from "cloudflare:workers"` only exposes `WorkerEntrypoint` subclasses defined **inline** in the entry module — re-exports from chunks resolve to `null`.

**Fix:** Extract the `emailSendCallback` state and `setEmailSendCallback` / `getEmailSendCallback` functions into a new `email-callback.ts` module. `runner.ts` now imports from `./email-callback.js` instead of `./bridge.js`, breaking the cross-path dependency. With `bridge.ts` only reachable from the worker entry path, Rollup inlines `PluginBridge` directly into `entry.mjs`, making `exports.PluginBridge` resolvable.
