# @emdash-cms/plugin-cli

CLI for authoring, building, and publishing EmDash plugins.

> EXPERIMENTAL: `init`, `build`, `dev`, `bundle`, `login`, `whoami`, `switch`, and `publish` all work today against any atproto PDS — `publish` writes profile + release records to the publisher's own repo. The discovery commands (`search`, `info`) need an aggregator; the experimental aggregator is at `registry.emdashcms.com`. NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.

## Installation

```sh
npx @emdash-cms/plugin-cli init my-plugin
```

Or install globally:

```sh
npm install -g @emdash-cms/plugin-cli
emdash-plugin init my-plugin
```

## Commands

```text
emdash-plugin init [name]                    Scaffold a new sandboxed plugin
emdash-plugin build                          Build dist/ artifacts (plugin.mjs, manifest.json, index.mjs)
emdash-plugin dev                            Watch sources and rebuild on change
emdash-plugin bundle                         Pack dist/ + assets into a registry tarball
emdash-plugin publish --url <url>            Publish a release that points at a hosted tarball
emdash-plugin validate [path]                Validate emdash-plugin.jsonc against the v1 schema
emdash-plugin login <handle-or-did>          Interactive atproto OAuth login
emdash-plugin logout [--did <did>]           Revoke the active session
emdash-plugin whoami                         Show stored sessions
emdash-plugin switch <did>                   Switch the active publisher session
emdash-plugin search <query>                 Free-text search
emdash-plugin info <handle-or-did> <slug>    Show package details
```

The non-interactive output commands (`whoami`, `validate`, `search`, `info`, `login`, `publish`) accept `--json` for machine-readable output. Discovery commands (`search`, `info`) accept `--registry-url <url>` (or `EMDASH_REGISTRY_URL`).

## Authoring

A typical plugin's `package.json` scripts:

```json
{
	"scripts": {
		"build": "emdash-plugin build",
		"dev": "emdash-plugin dev"
	}
}
```

The plugin author writes two files:

- `emdash-plugin.jsonc` — identity (slug, publisher) + trust contract (capabilities, allowedHosts, storage) + profile fields.
- `src/plugin.ts` — runtime behaviour (hooks + routes), with `export default { ... } satisfies SandboxedPlugin` from `emdash/plugin`.

`emdash-plugin build` produces:

- `dist/plugin.mjs` (+ `dist/plugin.d.mts`) — runtime bytes the integration loads (in-process or in a sandbox isolate).
- `dist/manifest.json` — wire-shape manifest including the hooks + routes harvested from probing `src/plugin.ts`.
- `dist/index.mjs` (+ `dist/index.d.mts`) — descriptor module that default-exports a bare `PluginDescriptor`. Consumers import this directly.

## Publishing

Three steps. The CLI does not host artifacts — you do, anywhere public.

```sh
emdash-plugin bundle
# upload dist/<id>-<version>.tar.gz somewhere public
emdash-plugin publish --url https://example.com/foo-1.0.0.tar.gz
```

On first publish, pass `--license` and `--security-email` (or `--security-url`) to bootstrap the package profile — or keep them in `emdash-plugin.jsonc` (see below).

## `emdash-plugin.jsonc`

Drop an `emdash-plugin.jsonc` file next to your plugin's `package.json`. The CLI reads it automatically from the current directory. Schema-driven IDE completion works via the bundled JSON Schema:

```jsonc
{
	"$schema": "./node_modules/@emdash-cms/plugin-cli/schemas/emdash-plugin.schema.json",

	"slug": "gallery",
	"publisher": "did:plc:abc123def456",

	"license": "MIT",
	"author": { "name": "Jane Doe", "url": "https://example.com" },
	"security": { "email": "security@example.com" },

	// Optional
	"name": "Gallery",
	"description": "Image gallery block for EmDash.",
	"keywords": ["gallery", "images"],
	"repo": "https://github.com/example/plugin-gallery",

	// Trust contract
	"capabilities": ["content:read"],
	"allowedHosts": [],
	"storage": {},
}
```

The file is JSONC: comments and trailing commas are allowed. Use `authors: [...]` and `securityContacts: [...]` for multi-author or multi-contact plugins. `version` is optional — when omitted, the CLI reads `version` from the adjacent `package.json`.

### Publisher pinning

After your first successful publish, the CLI writes the active session's DID back into the manifest as `publisher`:

```jsonc
{
	"license": "MIT",
	"publisher": "did:plc:abc123def456",
	...
}
```

On every subsequent publish, the CLI verifies the active session matches the pinned `publisher`. If they don't match, publish refuses with `MANIFEST_PUBLISHER_MISMATCH` so you can't accidentally publish under the wrong account. To resolve a mismatch, either:

- switch sessions: `emdash-plugin switch <did>`
- update the manifest if you're transferring the plugin to a new publisher

**DIDs are the identity, not handles.** Internally the CLI always compares the active session's DID against the pinned publisher's DID. If you pin a handle (`"publisher": "example.com"`), the CLI resolves it to a DID at publish time and compares against that — so a handle pin is just a friendlier alias for the underlying DID. Handles are mutable: if the publisher's domain changes ownership and the resolver later points at a different DID, the publish will refuse. DIDs are durable and the recommended pin for long-lived plugins.

Validate without publishing:

```sh
emdash-plugin validate
```

CLI flags (`--license`, `--author-name`, …) still win over manifest values when both are set, which is useful in CI. Pass `--no-manifest` to skip the manifest entirely.

## Programmatic API

```ts
import { buildPlugin, bundlePlugin } from "@emdash-cms/plugin-cli";

await buildPlugin({ dir: "./my-plugin" });
const result = await bundlePlugin({ dir: "./my-plugin" });
```

For discovery and credentials, import from `@emdash-cms/registry-client`.
