# @emdash-cms/registry-cli

## 0.2.0

### Minor Changes

- [#1040](https://github.com/emdash-cms/emdash/pull/1040) [`e6f7311`](https://github.com/emdash-cms/emdash/commit/e6f731163d7595a99b12105652aa0459e4dc8c7f) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash-plugin.jsonc` manifest support. Plugin authors can now declare profile fields (license, author, security contact, name, description, keywords, repo) once in a hand-edited JSONC file instead of passing them as flags on every publish. The CLI loads `./emdash-plugin.jsonc` automatically; explicit flags still win for CI use.

  New `emdash-plugin validate` command checks a manifest against the schema offline with `tsc`-style file:line:column diagnostics.

  The manifest's optional `publisher` field pins the publishing identity. On first successful publish, the CLI writes the active session's DID back to the manifest. Subsequent publishes verify the active session matches the pinned publisher and refuse on mismatch to prevent accidental cross-account publishes.

  JSON Schema for IDE completion ships in the package at `schemas/emdash-plugin.schema.json`; reference it via `"$schema": "./node_modules/@emdash-cms/plugin-cli/schemas/emdash-plugin.schema.json"`.

- [#1057](https://github.com/emdash-cms/emdash/pull/1057) [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames `@emdash-cms/registry-cli` to `@emdash-cms/plugin-cli` and the binary from `emdash-registry` to `emdash-plugin`. The package's job has outgrown the original name — `init`, `build`, `dev`, `bundle`, `publish`, `search`, `info`, `login`, `logout`, `whoami`, and `switch` cover plugin authoring + identity + discovery, not just registry interaction. Adopt the new name on first install; the old package is no longer published.

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

### Patch Changes

- [#1091](https://github.com/emdash-cms/emdash/pull/1091) [`6725e91`](https://github.com/emdash-cms/emdash/commit/6725e914319dc0f0e6a4b0442694fa9e9757e4af) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames the multi-word flags on `build`, `dev`, and `bundle` from camelCase to kebab-case for consistency with `publish` and standard Unix CLI convention.
  - `--outDir` -> `--out-dir`
  - `--validateOnly` -> `--validate-only`

  The short alias `-o` for `--out-dir` is unchanged.

- [#1092](https://github.com/emdash-cms/emdash/pull/1092) [`6788829`](https://github.com/emdash-cms/emdash/commit/67888292c85c56dda3b39450a020353fb0f17cc8) Thanks [@ascorbic](https://github.com/ascorbic)! - Renames the `--aggregator` flag on `search` and `info` to `--registry-url` for consistency with the `EMDASH_REGISTRY_URL` env var and the rest of the user-facing surface. Internally the override still selects the aggregator service to query — the rename only affects what users type.

  Old:

  ```sh
  emdash-plugin search "image" --aggregator https://registry.example.com
  ```

  New:

  ```sh
  emdash-plugin search "image" --registry-url https://registry.example.com
  ```

## 0.1.0

### Minor Changes

- [#978](https://github.com/emdash-cms/emdash/pull/978) [`27e6d58`](https://github.com/emdash-cms/emdash/commit/27e6d58ec1ba547ece4736ac0a87309812a95681) Thanks [@ascorbic](https://github.com/ascorbic)! - Enforces the sandboxed plugin bundle size caps from RFC 0001 §"Bundle size limits" in both the `bundle` and `publish` CLI flows: total decompressed ≤ 256 KB, per-file decompressed ≤ 128 KB, and at most 20 files per bundle. The previous bundle command capped only the total at 5 MB; the publish command now also re-validates the decompressed tarball before signing the release record so a publisher hits the same cap locally that aggregators enforce at ingest. Bundles between 256 KB and the old 5 MB ceiling will now be rejected — usually a sign the plugin is bundling host-provided dependencies or assets that belong in a CDN rather than the plugin payload.

### Patch Changes

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes the CLI hanging indefinitely after a successful `login` or `logout`. `run()` was returning correctly, but something in the OAuth path left a ref'd handle alive that prevented Node's event loop from draining. Workaround: force-exit at the top level once `runMain` resolves. The underlying handle leak is unidentified.

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Switches the login flow to request granular OAuth scopes derived from the `@emdash-cms/registry-lexicons` lexicon set instead of the broad `transition:generic`: `repo:` for every record-shaped lexicon (package profile, package release, publisher profile, publisher verification) and `rpc:<nsid>?aud=*` for every aggregator query (`getLatestRelease`, `getPackage`, `listReleases`, `resolvePackage`, `searchPackages`). Display name resolution no longer goes through `com.atproto.server.getSession`; the handle is read from the DID document via `LocalActorResolver` so the CLI doesn't need an `rpc:com.atproto.*` scope and isn't affected by PDS-side DPoP/Bearer compatibility quirks. If the PDS rejects the granular scopes with `invalid_scope`, login automatically retries once with `transition:generic` and prints a notice. Existing sessions continue working with their original scope until they're revoked or re-issued.

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Improves `login` error reporting for OAuth response failures. Previously, transient PDS errors surfaced as a bare `unknown_error` with a stack trace; the CLI now prints the HTTP status, endpoint, OAuth error code/description, a body snippet when the response wasn't OAuth-shaped JSON, and a hint to retry on 5xx responses.

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-cli`: standalone CLI for the experimental plugin registry. Subcommands for `login`, `logout`, `whoami`, `switch`, `search`, `info`, `bundle`, and `publish`. Atproto OAuth via loopback callback server. The `publish` flow fetches the tarball from the URL, verifies a sha256 multihash, extracts and validates `manifest.json`, locally validates each lexicon record, and atomically writes profile + release records (with the EmDash declaredAccess trust extension) via a single atproto `applyWrites`. Distributes via `npx @emdash-cms/registry-cli` to keep atproto deps out of the core CMS install.

- Updated dependencies [[`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31), [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209), [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31)]:
  - @emdash-cms/plugin-types@0.0.1
  - @emdash-cms/registry-client@0.0.1
  - @emdash-cms/registry-lexicons@0.1.0
