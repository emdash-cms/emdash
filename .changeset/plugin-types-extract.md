---
"emdash": patch
---

Refactors the plugin manifest types to re-export from `@emdash-cms/plugin-types`. The capability vocabulary (`PluginCapability`, `CAPABILITY_RENAMES`, `normalizeCapability`, `isDeprecatedCapability`) and manifest shape (`ManifestHookEntry`, `ManifestRouteEntry`, `PluginStorageConfig`, `StorageCollectionConfig`) now live in the shared package so the registry CLI can write the same types core reads. Existing imports from `emdash`'s plugin types module continue to work unchanged.
