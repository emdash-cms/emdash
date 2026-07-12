# @emdash-cms/registry-client

Atproto-aware client for the EmDash plugin registry.

> EXPERIMENTAL: targets `com.emdashcms.experimental.*` and the experimental aggregator. Pin to an exact version while RFC 0001 is in flight.

## Layers

This package is split into four independent surfaces. Import only the one you need.

### Credentials (`@emdash-cms/registry-client/credentials`)

Persists a publisher's atproto session between CLI invocations. Three implementations:

- `FileCredentialStore` -- `~/.emdash/credentials.json`, mode 0600. Atomic writes via temp-file rename. Default for interactive use.
- `EnvCredentialStore` -- read-only, reads `EMDASH_PUBLISHER_*` env vars. Use in CI.
- `MemoryCredentialStore` -- in-memory, for tests.

`defaultCredentialStore()` picks the env store if the env vars are set, otherwise the file store.

### Publishing (`@emdash-cms/registry-client/publishing`)

Repo operations against the publisher's own PDS: `putRecord`, `uploadBlob`, `getRecord`, `listRecords`. Used by the CLI's `emdash-plugin publish` flow.

The interactive OAuth flow lives in the CLI, not here. This module accepts a pre-built atproto fetch handler (typically from `@atcute/oauth-node-client`) and wraps it with operations scoped to atproto repo NSIDs.

### Discovery (`@emdash-cms/registry-client/discovery`)

Read-only XRPC client over an aggregator. No authentication. Used by the CLI (`emdash-plugin search`, `emdash-plugin info`) and the EmDash admin UI's install flow.

The `acceptLabelers` option threads the `atproto-accept-labelers` request header through every call so callers can configure which labelers' hard-takedown labels the aggregator should apply. The `onResponseMeta` option reports the `atproto-content-labelers` response header per call -- the labeler policy the aggregator actually applied -- for use with `resolveAcceptedPolicy` below.

### Moderation (`@emdash-cms/registry-client/moderation`)

Evaluates the typed moderation state -- `eligible` / `pending` / `error` / `blocked`, plus warning and suppressed labels -- of a package's release from the labels a discovery response hydrates onto its package and release views. Built on `@emdash-cms/registry-moderation`'s hydrated (structurally validated, not cryptographically verified) evaluation path, since the aggregator relays labels it does not sign for this client.

- `evaluateReleaseViews({ packageView, releaseView, publisherDid, accepted, evaluatedAt? })` merges the package and release views' hydrated labels and evaluates them. A label that fails structural validation is skipped with a console warning rather than failing the whole evaluation.
- `resolveAcceptedPolicy({ configuredAcceptLabelers?, contentLabelersHeader? })` picks the accepted-labeler policy to evaluate against: the response header when present (what the aggregator actually applied), else the configured `acceptLabelers` value, else no client-side enforcement.

## Stability

While `0.x`:

- The interactive-login flow (CLI integration) is intentionally not implemented in this package and may move elsewhere.
- Credential file format may evolve; the on-disk envelope carries a `version` field for forward compatibility.
- NSIDs and lexicon shapes track `@emdash-cms/registry-lexicons`.
