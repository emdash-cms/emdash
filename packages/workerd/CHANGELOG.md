# @emdash-cms/sandbox-workerd

## 0.1.0

### Minor Changes

- [#426](https://github.com/emdash-cms/emdash/pull/426) [`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74) Thanks [@BenjaminPrice](https://github.com/BenjaminPrice)! - Adds workerd-based plugin sandboxing for Node.js deployments.
  - **emdash**: Adds `isHealthy()` to `SandboxRunner` interface, `SandboxUnavailableError` class, `sandbox: false` config option, `mediaStorage` field on `SandboxOptions`, and exports `createHttpAccess`/`createUnrestrictedHttpAccess`/`PluginStorageRepository`/`UserRepository`/`OptionsRepository` for platform adapters.
  - **@emdash-cms/cloudflare**: Implements `isHealthy()` on `CloudflareSandboxRunner`. Fixes `storageQuery()` and `storageCount()` to honor `where`, `orderBy`, and `cursor` options (previously ignored, causing infinite pagination loops and incorrect filtered counts). Adds `storageConfig` to `PluginBridgeProps` so `PluginStorageRepository` can use declared indexes.
  - **@emdash-cms/sandbox-workerd**: New package. `WorkerdSandboxRunner` for production (workerd child process + capnp config + authenticated HTTP backing service) and `MiniflareDevRunner` for development.

### Patch Changes

- [#1144](https://github.com/emdash-cms/emdash/pull/1144) [`c50c3b2`](https://github.com/emdash-cms/emdash/commit/c50c3b2fa8a53d12f90d76f009ef82bfd4a47fcd) Thanks [@ascorbic](https://github.com/ascorbic)! - Aligns the `kysely` peer dependency with the rest of the monorepo (`>=0.29.0`) and switches the dev/peer references to the workspace catalog so all packages bump in lockstep going forward.

- [#1147](https://github.com/emdash-cms/emdash/pull/1147) [`20c87fe`](https://github.com/emdash-cms/emdash/commit/20c87fe9248caa276a2083d50b996302deebb0c5) Thanks [@ascorbic](https://github.com/ascorbic)! - Tightens the workerd sandbox internals so the package now lints and type-checks cleanly.
  - Bridge call bodies are validated with predicate-backed `require*` / `optional*` helpers instead of unchecked `as` casts. A misbehaving plugin that sends a malformed JSON-RPC body now gets a clear "Parameter X must be Y" error rather than triggering a downstream type confusion.
  - Content table access (`ec_*` collections) is centralised behind a typed `asContentDb()` helper. Known tables (`users`, `media`, `_plugin_storage`) drop their `as keyof Database` casts entirely.
  - HTTP `init` marshalling validates each field at the bridge boundary, including form-data parts.
  - The backing service uses a typed `HttpError` class for status-bearing errors and validates incoming chunks/body shape defensively.
  - `getPluginStorageConfig()` returns the real `PluginStorageConfig` shape from the manifest instead of `Record<string, unknown>`.
  - `WorkerdSandboxedPlugin` now implements the correct `SandboxedPluginInstance` interface (the old `SandboxedPlugin` symbol did not exist).
  - Adds a `typecheck` script (`tsgo --noEmit`) so the package participates in `pnpm typecheck` going forward.

  No runtime behaviour changes.

- Updated dependencies [[`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74), [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b), [`fae97ee`](https://github.com/emdash-cms/emdash/commit/fae97ee5465934365864557e9fa3ee8754cfd49c), [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61), [`9a30607`](https://github.com/emdash-cms/emdash/commit/9a30607791a2f27473b1d2fe7700291e0be1ea1c), [`d0ff94b`](https://github.com/emdash-cms/emdash/commit/d0ff94bd476e7fd4b5d18c94904cfb5c071fea92)]:
  - emdash@0.15.0
