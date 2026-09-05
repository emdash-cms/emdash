# @emdash-cms/registry-client

Atproto-aware client for the EmDash plugin registry.

> EXPERIMENTAL: targets `com.emdashcms.experimental.*` and the experimental aggregator. Pin to an exact version while RFC 0001 is in flight.

## Public surfaces

Import the smallest subpath that covers your task.

### Credentials (`@emdash-cms/registry-client/credentials`)

Persists a publisher's atproto session between CLI invocations. Three implementations:

- `FileCredentialStore` -- `~/.emdash/credentials.json`, mode 0600. Atomic writes via temp-file rename. Default for interactive use.
- `EnvCredentialStore` -- read-only, reads `EMDASH_PUBLISHER_*` env vars. Use in CI.
- `MemoryCredentialStore` -- in-memory, for tests.

`defaultCredentialStore()` picks the env store if the env vars are set, otherwise the file store.

### Publishing (`@emdash-cms/registry-client/publishing`)

Repo operations against the publisher's own PDS: `putRecord`, `uploadBlob`, `getRecord`, `listRecords`. Used by the CLI's `emdash-plugin publish` flow.

The interactive OAuth flow lives in the CLI, not here. This module accepts a pre-built atproto fetch handler (typically from `@atcute/oauth-node-client`) and wraps it with operations scoped to atproto repo NSIDs.

### Delegated releases (`@emdash-cms/registry-client/release-service`)

Typed clients and resource shapes for the delegated release service:

- `ReleaseServiceClient` covers GitHub OIDC workflow connections, staged artifact uploads, release intents, publisher sessions, passkey approvals, and publisher dashboard requests.
- `ReleaseServiceOperatorClient` covers Cloudflare Access-protected status, directory, pause, suspension, reconciliation, encryption, archive, and restore operations.
- `ReleaseServiceError` exposes the stable service or client code, public-safe message, HTTP status, and retryable classification.

The client does not exchange GitHub OIDC for AT Protocol authority. Workload methods request a fresh token through the caller-provided `workloadToken` function; the release service holds its separate create-only publisher delegation.

Follow [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/) for the standard CLI and GitHub Actions flow.

### Direct PDS reads (`@emdash-cms/registry-client/direct-pds`)

`DirectPdsClient` verifies package profiles and releases against repository proofs and the signing key in the publisher's DID document. The release service uses it to bind workflow and approval decisions to authoritative profile and release revisions.

### Discovery (`@emdash-cms/registry-client/discovery`)

Read-only XRPC client over an aggregator. No authentication. Used by the CLI (`emdash-plugin search`, `emdash-plugin info`) and the EmDash admin UI's install flow.

The `acceptLabelers` option sends a comma-separated declaration of bare labeller DIDs with every request. The client includes the declaration in its stable policy cache identity. The aggregator validates it, but its configured approval, block, takedown, and withdrawal policy remains authoritative.

### Listing policy (`@emdash-cms/registry-client/listing-policy`)

Creates the required listing-policy value used by official clients, maps `ListingUnavailable` responses to a safe status result, and provides a stable cache key that includes the accepted-labeller declaration.

### Withdrawal (`@emdash-cms/registry-client/withdrawal`)

Evaluates hydrated release-withdrawal labels through the shared moderation policy. Malformed label data fails closed.

### Environment compatibility (`@emdash-cms/registry-client/env`)

Parses release environment requirements and compares them with the host's EmDash and Astro versions.

## Stability

While `0.x`:

- The interactive-login flow (CLI integration) is intentionally not implemented in this package and may move elsewhere.
- Credential file format may evolve; the on-disk envelope carries a `version` field for forward compatibility.
- NSIDs and lexicon shapes track `@emdash-cms/registry-lexicons`.
