---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/workerd": minor
---

Adds workerd-based plugin sandboxing for Node.js deployments.

- **emdash**: Adds `isHealthy()` to `SandboxRunner` interface, `SandboxUnavailableError` class, `sandbox: false` config option, `mediaStorage` field on `SandboxOptions`, and exports `createHttpAccess`/`createUnrestrictedHttpAccess`/`PluginStorageRepository`/`UserRepository`/`OptionsRepository` for platform adapters.
- **@emdash-cms/cloudflare**: Implements `isHealthy()` on `CloudflareSandboxRunner`. Fixes `storageQuery()` and `storageCount()` to honor `where`, `orderBy`, and `cursor` options (previously ignored, causing infinite pagination loops and incorrect filtered counts). Adds `storageConfig` to `PluginBridgeProps` so `PluginStorageRepository` can use declared indexes.
- **@emdash-cms/workerd**: New package. `WorkerdSandboxRunner` for production (workerd child process + capnp config + authenticated HTTP backing service) and `MiniflareDevRunner` for development.
