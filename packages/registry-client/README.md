# @emdash-cms/registry-client

Atproto-aware client for the EmDash plugin registry.

> EXPERIMENTAL: targets `com.emdashcms.experimental.*` and the experimental aggregator. Pin to an exact version while RFC 0001 is in flight.

## Layers

This package is split into three independent surfaces. Import only the one you need.

### Credentials (`@emdash-cms/registry-client/credentials`)

Persists a publisher's atproto session between CLI invocations. Three implementations:

- `FileCredentialStore` -- `~/.emdash/credentials.json`, mode 0600. Atomic writes via temp-file rename. Default for interactive use.
- `EnvCredentialStore` -- read-only, reads `EMDASH_PUBLISHER_*` env vars. Use in CI.
- `MemoryCredentialStore` -- in-memory, for tests.

`defaultCredentialStore()` picks the env store if the env vars are set, otherwise the file store.

### Publishing (`@emdash-cms/registry-client/publishing`)

Repo operations against the publisher's own PDS: `putRecord`, `uploadBlob`, `getRecord`, `listRecords`. Used by the CLI's `emdash-registry publish` flow.

The interactive OAuth flow lives in the CLI, not here. This module accepts a pre-built atproto fetch handler (typically from `@atcute/oauth-node-client`) and wraps it with operations scoped to atproto repo NSIDs.

### Discovery (`@emdash-cms/registry-client/discovery`)

Read-only XRPC client over an aggregator. No authentication. Used by the CLI (`emdash-registry search`, `emdash-registry info`) and the EmDash admin UI's install flow.

The `acceptLabelers` option threads the `atproto-accept-labelers` request header through every call so callers can configure which labellers' hard-takedown labels the aggregator should apply.

## Stability

While `0.x`:

- The interactive-login flow (CLI integration) is intentionally not implemented in this package and may move elsewhere.
- Credential file format may evolve; the on-disk envelope carries a `version` field for forward compatibility.
- NSIDs and lexicon shapes track `@emdash-cms/registry-lexicons`.
