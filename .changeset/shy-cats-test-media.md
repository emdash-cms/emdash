---
"@emdash-cms/plugin-test": patch
"@emdash-cms/plugin-cli": patch
"emdash": patch
---

Adds a disposable R2 media binding to `emdashPluginTest()` so sandbox plugin tests can exercise `ctx.media.upload()` and `ctx.media.delete()` through the production Worker Loader bridge.

Fixes registry installation rejecting sandbox plugins that declare publication, restore, or publication-policy authority because core dropped those existing `declaredAccess` facets while validating the bundle manifest.

Fixes Zod-backed MCP declarations failing during the plugin CLI's temporary probe import. The probe now bundles Zod, and the generated sandbox entry exports only runtime hooks and routes while preserving Zod for handlers that use it inside the isolate.
