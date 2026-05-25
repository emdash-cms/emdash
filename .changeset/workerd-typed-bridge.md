---
"@emdash-cms/sandbox-workerd": patch
---

Tightens the workerd sandbox internals so the package now lints and type-checks cleanly.

- Bridge call bodies are validated with predicate-backed `require*` / `optional*` helpers instead of unchecked `as` casts. A misbehaving plugin that sends a malformed JSON-RPC body now gets a clear "Parameter X must be Y" error rather than triggering a downstream type confusion.
- Content table access (`ec_*` collections) is centralised behind a typed `asContentDb()` helper. Known tables (`users`, `media`, `_plugin_storage`) drop their `as keyof Database` casts entirely.
- HTTP `init` marshalling validates each field at the bridge boundary, including form-data parts.
- The backing service uses a typed `HttpError` class for status-bearing errors and validates incoming chunks/body shape defensively.
- `getPluginStorageConfig()` returns the real `PluginStorageConfig` shape from the manifest instead of `Record<string, unknown>`.
- `WorkerdSandboxedPlugin` now implements the correct `SandboxedPluginInstance` interface (the old `SandboxedPlugin` symbol did not exist).
- Adds a `typecheck` script (`tsgo --noEmit`) so the package participates in `pnpm typecheck` going forward.

No runtime behaviour changes.
