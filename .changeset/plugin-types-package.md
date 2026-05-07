---
"@emdash-cms/plugin-types": patch
---

Adds `@emdash-cms/plugin-types`: shared TypeScript types for the EmDash plugin manifest contract — capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `isDeprecatedCapability`, `normalizeCapability`), manifest shape (`PluginManifest`, `ManifestHookEntry`, `ManifestRouteEntry`, `PluginAdminConfig`, `PluginStorageConfig`). Consumed by both `emdash` (manifest reader at install/runtime) and `@emdash-cms/registry-cli` (manifest writer at bundle/publish time). After the registry phase 1 cutover removes the legacy bundling code from core, both sides will continue depending on this single source of truth.
