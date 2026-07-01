# @emdash-cms/plugin-types

## 0.1.0

### Minor Changes

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

## 0.0.1

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/plugin-types`: shared TypeScript types for the EmDash plugin manifest contract — capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `isDeprecatedCapability`, `normalizeCapability`), manifest shape (`PluginManifest`, `ManifestHookEntry`, `ManifestRouteEntry`, `PluginAdminConfig`, `PluginStorageConfig`). Consumed by both `emdash` (manifest reader at install/runtime) and `@emdash-cms/registry-cli` (manifest writer at bundle/publish time). After the registry phase 1 cutover removes the legacy bundling code from core, both sides will continue depending on this single source of truth.
