# @emdash-cms/plugin-types

## 0.0.1

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/plugin-types`: shared TypeScript types for the EmDash plugin manifest contract — capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `isDeprecatedCapability`, `normalizeCapability`), manifest shape (`PluginManifest`, `ManifestHookEntry`, `ManifestRouteEntry`, `PluginAdminConfig`, `PluginStorageConfig`). Consumed by both `emdash` (manifest reader at install/runtime) and `@emdash-cms/registry-cli` (manifest writer at bundle/publish time). After the registry phase 1 cutover removes the legacy bundling code from core, both sides will continue depending on this single source of truth.
