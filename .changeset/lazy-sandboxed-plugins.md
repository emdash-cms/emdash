---
"emdash": patch
---

Lazily load sandboxed plugins so they no longer block the first request of a cold isolate.

Previously, every build-time sandboxed plugin was provisioned on the Worker Loader during runtime init, so the first request of each cold isolate — including anonymous reads — waited on plugins it never exercised. A write-only plugin (declaring only `content:afterSave`/`afterDelete`, for example) could add over a second to content reads that never trigger it.

Plugins are now registered (cheap, synchronous) at init and loaded on first use of an extension point they actually declare. At build time the integration reads each plugin's `dist/manifest.json` and emits its declared hooks/routes; hook and route dispatch load only the plugins relevant to the current event, preserving config order. Plugins without a manifest are treated as "unknown" and loaded eagerly to stay correct. Route authorization is seeded from declared routes, so a route can be authorized without provisioning the isolate. A public render loads no plugin that doesn't declare `page:metadata`.

No public API or configuration change — purely an internal performance improvement. Marketplace/registry plugins remain eagerly loaded for now.
