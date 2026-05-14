# @emdash-cms/registry-cli

CLI for the experimental EmDash plugin registry.

> EXPERIMENTAL: `bundle`, `login`, `whoami`, `switch`, and `publish` all work today against any atproto PDS — `publish` writes profile + release records to the publisher's own repo. The discovery commands (`search`, `info`) need an aggregator; none is deployed yet, so those won't return useful results until one is. NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.

## Installation

```sh
npx @emdash-cms/registry-cli bundle
```

Or install globally:

```sh
npm install -g @emdash-cms/registry-cli
emdash-registry bundle
```

## Commands

```text
emdash-registry login <handle-or-did>          Interactive atproto OAuth login
emdash-registry logout [--did <did>]           Revoke the active session
emdash-registry whoami                         Show stored sessions
emdash-registry switch <did>                   Switch the active publisher session
emdash-registry search <query>                 Free-text search
emdash-registry info <handle-or-did> <slug>    Show package details
emdash-registry bundle                         Bundle a plugin source dir into a tarball
emdash-registry publish --url <url>            Publish a release that points at a hosted tarball
emdash-registry validate [path]                Validate emdash-plugin.jsonc against the v1 schema
```

All commands accept `--json`. Discovery commands accept `--aggregator <url>` (or `EMDASH_REGISTRY_URL`).

## Publishing

Three steps. The CLI does not host artifacts — you do, anywhere public.

```sh
emdash-registry bundle
# upload dist/<id>-<version>.tar.gz somewhere public
emdash-registry publish --url https://example.com/foo-1.0.0.tar.gz
```

On first publish, pass `--license` and `--security-email` (or `--security-url`) to bootstrap the package profile — or keep them in `emdash-plugin.jsonc` (see below).

## `emdash-plugin.jsonc`

Drop an `emdash-plugin.jsonc` file next to your plugin's `package.json` to declare profile fields once instead of passing them on every publish. The CLI reads it automatically from the current directory. Schema-driven IDE completion works via the bundled JSON Schema:

```jsonc
{
	"$schema": "./node_modules/@emdash-cms/registry-cli/schemas/emdash-plugin.schema.json",

	"license": "MIT",
	"author": { "name": "Jane Doe", "url": "https://example.com" },
	"security": { "email": "security@example.com" },

	// Optional
	"name": "Gallery",
	"description": "Image gallery block for EmDash.",
	"keywords": ["gallery", "images"],
	"repo": "https://github.com/example/plugin-gallery",
}
```

The file is JSONC: comments and trailing commas are allowed. Use `authors: [...]` and `securityContacts: [...]` for multi-author or multi-contact plugins.

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

- switch sessions: `emdash-registry switch <did>`
- update the manifest if you're transferring the plugin to a new publisher

**DIDs are the identity, not handles.** Internally the CLI always compares the active session's DID against the pinned publisher's DID. If you pin a handle (`"publisher": "example.com"`), the CLI resolves it to a DID at publish time and compares against that — so a handle pin is just a friendlier alias for the underlying DID. Handles are mutable: if the publisher's domain changes ownership and the resolver later points at a different DID, the publish will refuse. DIDs are durable and the recommended pin for long-lived plugins.

Validate without publishing:

```sh
emdash-registry validate
```

CLI flags (`--license`, `--author-name`, …) still win over manifest values when both are set, which is useful in CI. Pass `--no-manifest` to skip the manifest entirely.

## Programmatic API

```ts
import { bundlePlugin } from "@emdash-cms/registry-cli";

const result = await bundlePlugin({ dir: "./my-plugin" });
```

For discovery and credentials, import from `@emdash-cms/registry-client`.
