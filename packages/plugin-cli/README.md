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
emdash-plugin publish                        Build, upload, and publish a release
emdash-plugin release setup                  Create the permanent GitHub release workflow
emdash-plugin release delegate               Print a publisher delegation browser handoff
emdash-plugin release revoke                 Print an authority revocation browser handoff
emdash-plugin release workload               Print a workload policy browser handoff
emdash-plugin release enrol                  Print a passkey enrolment browser handoff
emdash-plugin release approve <intent-id>    Print a passkey approval browser handoff
emdash-plugin release reject <intent-id>     Print a passkey rejection browser handoff
emdash-plugin release dry-run <release.json> Validate delegated release admission with GitHub OIDC
emdash-plugin release submit <release.json>  Submit a delegated release with GitHub OIDC
emdash-plugin release status <intent-id>     Read a delegated release intent
emdash-plugin release cancel <intent-id>     Cancel an unpublished delegated release intent
emdash-plugin validate [path]                Validate emdash-plugin.jsonc against the v1 schema
emdash-plugin login <handle-or-did>          Interactive atproto OAuth login
emdash-plugin logout [--did <did>]           Revoke the active session
emdash-plugin whoami                         Show stored sessions
emdash-plugin switch <did>                   Switch the active publisher session
emdash-plugin search <query>                 Free-text search
emdash-plugin info <handle-or-did> <slug>    Show package details
```

The non-interactive output commands accept `--json` for machine-readable output. Discovery commands (`search`, `info`) accept `--registry-url <url>` (or `EMDASH_REGISTRY_URL`).

## Development

From a fresh checkout, run `pnpm install` and then `pnpm build` before a scoped package typecheck:

```sh
pnpm install
pnpm build
pnpm --filter @emdash-cms/plugin-cli typecheck
```

The build emits internal workspace type declarations used by the scoped typecheck, matching CI's build-then-typecheck order.

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

The CLI builds the plugin and uploads the release artifacts to your PDS:

```sh
emdash-plugin login <handle-or-did>
emdash-plugin publish
```

Pass `--url https://example.com/foo-1.0.0.tar.gz` to use an externally hosted bundle. The CLI downloads that URL to validate the bytes and compute the checksum. Listing images declared under `release.artifacts` are still uploaded to your PDS.

On first publish, pass `--license` and `--security-email` (or `--security-url`) to bootstrap the package profile — or keep them in `emdash-plugin.jsonc` (see below).

## Delegated releases

Run the setup command from a public GitHub repository containing an EmDash plugin:

```sh
emdash-plugin release setup
```

The command reads the plugin publisher from `emdash-plugin.jsonc` and creates `.github/workflows/emdash-release.yml`. Review and commit that file. The command does not push or change an existing workflow; pass `--force` to replace one deliberately.

The generated workflow builds the plugin, creates signed GitHub build provenance, and publishes on version tags or a manual run. Private and internal GitHub repositories are not supported because their attestations use a private Sigstore trust root that the release verifier does not trust.

Sign in to the release-service dashboard with the Atmosphere account that owns the plugin and authorize EmDash to create plugin releases. Enter the plugin ID under **Connect another GitHub Actions workflow**, then create an invitation. Add the one-time value to the GitHub repository as an Actions secret named `EMDASH_CONNECTION_INVITATION`.

Start the workflow within 30 minutes by pushing a version tag such as `v1.2.3`. The first run consumes the invitation, waits, and adds an approval link to the GitHub job summary. Open that link, check the repository, workflow file, branch or tag, and environment, then confirm the workflow. The same run continues after confirmation. If the invitation expires before the workflow consumes it, create another invitation and update the secret.

For a release started from a tag, the dashboard can authorize all version tags or only the current tag. Repository and workflow paths remain exact in both cases.

The workflow uploads the bundle and raw Sigstore attestation to private, transient service storage with a fresh GitHub Actions OpenID Connect (OIDC) token for each request. The service verifies the exact bytes, uploads the plugin bundle to the publisher's personal data server (PDS), and publishes a release record containing the PDS blob. The published provenance URL points to the immutable verified attestation.

The lower-level automation commands (`dry-run`, `submit`, `status`, and `cancel`) remain available for custom workflows. They authenticate with the current GitHub Actions OIDC identity and accept a hand-authored URL-source release record.

The following command submits a generated URL-source package release record and waits for publication or an approval request:

```sh
emdash-plugin release submit release.json \
  --service-url https://release.example.com \
  --publisher-did did:web:publisher.example.com
```

Set `EMDASH_RELEASE_SERVICE_URL` and `EMDASH_PUBLISHER_DID` to omit the two target flags. An unmatched custom workflow also reads its one-time invitation from `EMDASH_CONNECTION_INVITATION`. The default idempotency key uses the GitHub run ID, so a re-run reuses the existing intent. Pass `--idempotency-key` when separate runs or jobs must replay the same submission.

Each package or listing-image artifact in a hand-authored source record must use a checksum-bound HTTPS `url` and must not include `blob`. The published release record contains PDS blob references and no artifact source URLs.

Use `--no-wait` to return after the service accepts the intent. The status and cancellation commands require the same publisher and GitHub workload identity:

```sh
emdash-plugin release status 01JABCDEFGHJKMNPQRSTVWXYZ0
emdash-plugin release cancel 01JABCDEFGHJKMNPQRSTVWXYZ0
```

These commands fail outside GitHub Actions because no OIDC request endpoint is available. Use `release setup` for the standard workflow.

Atmosphere authorization and passkeys remain browser operations. The following commands print validated browser links instead of copying OAuth sessions or passkey assertions into the terminal:

```sh
emdash-plugin release delegate --service-url https://release.example.com
emdash-plugin release workload --service-url https://release.example.com
emdash-plugin release enrol --service-url https://release.example.com
emdash-plugin release approve 01JABCDEFGHJKMNPQRSTVWXYZ0 \
  --service-url https://release.example.com \
  --publisher-did did:web:publisher.example.com
```

Use `release revoke` to open publisher authority revocation and `release reject` to open the rejection ceremony. The service keeps its application-session cookies and passkey ceremony at its own origin.

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
