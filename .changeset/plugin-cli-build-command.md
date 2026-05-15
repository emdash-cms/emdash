---
"@emdash-cms/plugin-cli": minor
---

Renames `@emdash-cms/registry-cli` to `@emdash-cms/plugin-cli` and the binary from `emdash-registry` to `emdash-plugin`. The package's job has outgrown the original name — `init`, `build`, `dev`, `bundle`, `publish`, `search`, `info`, `login`, `logout`, `whoami`, and `switch` cover plugin authoring + identity + discovery, not just registry interaction. Adopt the new name on first install; the old package is no longer published.

This release also adds `emdash-plugin build` and `emdash-plugin dev` and consolidates the build pipeline so `bundle` is a thin packaging step on top of `build`.

**`emdash-plugin build`** reads `emdash-plugin.jsonc` and `src/plugin.ts`, then emits:

- `dist/plugin.mjs` (+ `dist/plugin.d.mts`) — runtime bytes (hooks + routes). The same artifact is consumed both in-process (when the plugin is in `plugins: []`) and by the sandbox loader (when in `sandboxed: []`).
- `dist/manifest.json` — wire-shape `PluginManifest` including hooks + routes harvested from probing `src/plugin.ts`. `bundle` packs this verbatim into the registry tarball; on the npm path it's metadata that consumers can read without parsing JSONC.
- `dist/index.mjs` (+ `dist/index.d.mts`) — descriptor module that default-exports a bare `PluginDescriptor` object. Emitted only when a sibling `package.json` exists (registry-only plugins skip this, since nothing would import it).

**`emdash-plugin dev`** watches `src/**`, `emdash-plugin.jsonc`, and `package.json`, debouncing rebuilds at 150ms. On a failed rebuild it leaves the last good `dist/` in place so a downstream site importing the plugin keeps working until the next successful build. Stop with Ctrl-C.

A typical plugin `package.json`:

```json
{
  "scripts": {
    "build": "emdash-plugin build",
    "dev": "emdash-plugin dev"
  }
}
```

**`version` in `emdash-plugin.jsonc` is now optional.** The build reconciles the manifest's `version` with `package.json#version`:

- Both set and matching → fine.
- Both set and different → hard error.
- One set → that value wins.
- Neither set → hard error.

The recommended pattern for npm-distributed plugins is to omit `version` from the manifest and let `package.json` be the source of truth. Registry-only plugins (no `package.json`) must set `version` in the manifest.

**`emdash-plugin bundle`** has been reduced to a packaging step: it now calls `build` to produce `dist/`, validates the bundle contents (no Node-builtin imports, no oversized files, capability sanity), collects optional assets (README, icon, screenshots), and tarballs. Inside the tarball, `plugin.mjs` is renamed to `backend.js` to match the registry's wire-side filename. `validateOnly` still skips tarball creation but now produces the `dist/` artifacts (since "validate" implies "build first").
