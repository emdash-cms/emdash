# Delegated release service G0 PDS conformance

Status: Blob-enabled harness implemented; real blob-enabled public-client reruns and confidential-client deployment runs pending

Companion design: [RFC PR #1870](https://github.com/emdash-cms/emdash/pull/1870)

## Outcome

G0 establishes whether the delegated release service can hold the exact authority defined by the protocol on the first supported PDS implementations. The initial matrix covers the Bluesky PDS software hosted by npmX (`npmx.social`) and Cirrus.

Each provider must prove that the exact delegated scope:

- uploads gzip package bundles and raster listing images;
- creates a record in the active package-release collection;
- reads the created record through the public read path;
- cannot update or delete the release;
- cannot create a package profile;
- cannot create a record in an unrelated collection;
- refreshes through the confidential-client session as documented;
- responds to explicit revocation as documented; and
- stops refreshing sessions bound to a removed confidential-client key.

No result permits a fallback to `transition:generic` or another broad scope.

## Test accounts

Dedicated test accounts are available for:

- Bluesky PDS software hosted by npmX (`npmx.social`); and
- Cirrus.

Keep account handles, recovery material, OAuth state, DPoP keys, access tokens, refresh tokens, and client assertion private keys outside the repository. The evidence report contains the account DID, PDS URL, requested and returned scopes, token expiry metadata, probe results, and public release URI/CID. These values do not grant account access.

Use only dedicated conformance accounts. A successful run leaves its blob-referencing release record behind because the exact grant denies record deletion. The PDS owns blob garbage collection; the AT Protocol API does not expose a blob-delete operation. If an over-broad grant unexpectedly creates a profile or unrelated record, the harness attempts to delete only that run's record and reports whether cleanup succeeded.

## Harness surfaces

The internal `@emdash-cms/registry-client/internal/conformance` surface exports `runPdsScopeConformance()`. The caller supplies an authenticated AT Protocol handler. The same probe runner is used by:

- the loopback public-client preflight in `emdash-plugin pds-conformance`; and
- the release service's confidential-client conformance route when that client is deployed.

The caller supplies the exact scope-denial response expected for its provider. The npmX-hosted Bluesky PDS uses HTTP 403 `ScopeMissingError`; Cirrus uses HTTP 403 `InsufficientScope`. A denial passes only when both the status and error match. Another 4xx response, a network error, or a 5xx response is an inconclusive error and fails the run. A successful forbidden operation also fails the run.

The CLI never retries the exact scope with `transition:generic`.

## Prepare the workspace

Build the CLI and its workspace dependencies before running a real account:

```sh
pnpm --filter @emdash-cms/plugin-cli... build
```

Create a private evidence directory outside the repository. The following examples use placeholders; replace them with explicit absolute paths:

```sh
mkdir -m 700 <private-evidence-dir>
```

The CLI defaults OAuth state to `~/.emdash/pds-conformance/<provider>`. Pass `--state-dir` when the test requires a separate disposable location.

## Phase 1: exact-scope authorization

Run the command with the account handle. The browser consent screen must show the active release collection's create authority plus `blob:application/gzip` and `blob:image/*`.

The Bluesky preflight uses the following command:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<bluesky-account-handle> \
	--provider bluesky \
	--phase authorize \
	--state-dir <private-evidence-dir>/bluesky-oauth \
	--output <private-evidence-dir>/bluesky-authorize.json
```

The Cirrus preflight uses the following command:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<cirrus-account-handle> \
	--provider cirrus \
	--phase authorize \
	--state-dir <private-evidence-dir>/cirrus-oauth \
	--output <private-evidence-dir>/cirrus-authorize.json
```

Review the generated report. `probes.passed` must be `true`, `probes.blobs` must contain the returned gzip and PNG blob metadata, and the returned stored scope must equal the requested exact scope. Record the emitted DID for later phases.

The authorization phase proves granular scope enforcement through an AT Protocol loopback public client. It does not prove confidential-client assertion, refresh, or client-key behavior.

### npmX Bluesky-PDS result

The public-client authorization run completed on 2026-08-24:

- Account DID: `did:plc:2rskihsyau3rbh26veoi7mtx`
- OAuth issuer and PDS: `https://npmx.social`
- Granted scope: `atproto repo:com.emdashcms.experimental.package.release?action=create`
- Created release: `at://did:plc:2rskihsyau3rbh26veoi7mtx/com.emdashcms.experimental.package.release/emdash_g0_conformance:0.0.0-g0.355d87f8c7c7`
- Created CID: `bafyreidsvjqaaad5hn2dgstxx4slnnngw4lkj26mp3h7uvitzw2dk6nruu`
- Update, delete, profile-create, and unrelated-create probes: HTTP 403 `ScopeMissingError`
- Redacted evidence SHA-256: `d4be775c634969f8eb465f1c0c37a0788a388368314fc515a64774cfeec12590`

This historical result proves the record-create boundary for the earlier record-only scope. It does not pass the blob-enabled public-client scope column. The blob probes, refresh, and revocation must run again with the active scope.

### Cirrus result

The public-client authorization run completed on 2026-08-24:

- Account DID: `did:web:emdashtestaccount.emdashcms.com`
- OAuth issuer and PDS: `https://emdashtestaccount.emdashcms.com`
- Granted scope: `atproto repo:com.emdashcms.experimental.package.release?action=create`
- Created release: `at://did:web:emdashtestaccount.emdashcms.com/com.emdashcms.experimental.package.release/emdash_g0_conformance:0.0.0-g0.fa6b3dc0fe41`
- Created CID: `bafyreid6wzle4fvp2uyany3fzusg6gsewccyg4zjr6b3urhp2ijmphfmqu`
- Update, delete, profile-create, and unrelated-create probes: HTTP 403 `InsufficientScope`
- Redacted evidence SHA-256: `1abf5e389223879a41c7e260077b33ad457160acaed0ac328a158b1d8e6ec102`

This historical result proves the record-create boundary for the earlier record-only scope. It does not pass the blob-enabled public-client scope column. The blob probes, refresh, and revocation must run again with the active scope.

## Phase 2: refresh observation

Run the resume phase with the DID, not the handle:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<account-did> \
	--provider <bluesky-or-cirrus> \
	--phase resume \
	--state-dir <private-evidence-dir>/<provider>-oauth \
	--output <private-evidence-dir>/<provider>-refresh.json
```

The command forces a refresh through the stored exact-scope session, performs a new release create and denial matrix, then reads the non-secret stored-session metadata again. `oauth.refreshForced` and `oauth.refreshObserved` must both be `true`. `oauth.refreshDue` records whether the access token had already reached its reported expiry; it does not control whether refresh runs.

## Phase 3: explicit revocation observation

Run revocation with the DID:

```sh
node packages/plugin-cli/dist/index.mjs pds-conformance \
	<account-did> \
	--provider <bluesky-or-cirrus> \
	--phase revoke \
	--state-dir <private-evidence-dir>/<provider>-oauth \
	--output <private-evidence-dir>/<provider>-revoke.json
```

The command requires the authorization server's revocation request to complete, removes local session state, and records immediate post-revocation access-token behavior. Immediate access denial is desirable but is not required by the protocol: an already-issued access token may remain valid until expiry. The report therefore treats the post-revocation probes as observation rather than the ordinary scope verdict.

The account must reauthorize before another test cycle.

## Confidential-client conformance

G0 does not close on loopback-client evidence. The release service must repeat the same probes through its real confidential client:

1. Deploy the client metadata and JWKS endpoints on the service's HTTPS origin.
2. Configure `private_key_jwt` with an active assertion key and one overlapping previous public key.
3. Complete delegation through the service callback using the exact scope.
4. Call `runPdsScopeConformance()` with the restored confidential session handler.
5. Force refresh through the retained session and record the new expiry.
6. Call the authorization server's revocation endpoint and record immediate and post-expiry behavior.
7. Reauthorize using the previous assertion key, rotate the active key, retain the previous public key, and prove refresh still works.
8. Remove the previous public key and prove the bound session can no longer refresh after its current access token expires.

The service stores the assertion key ID with each delegation so the key-removal result can be attributed to the correct session generation.

## Evidence schema

Each CLI report contains:

- `version`: evidence schema version;
- `phase`: `authorize`, `resume`, or `revoke`;
- `provider`: `bluesky` or `cirrus`;
- `generatedAt`: report time;
- `oauth.requestedScope`;
- redacted session metadata before and after the phase;
- refresh and revocation observations; and
- the complete PDS probe report.

The PDS report contains one row for each probe:

| Probe                   | Expected result                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `package-blob-upload`   | Allowed; returned CID, `application/gzip` MIME type, and size match the uploaded bytes |
| `image-blob-upload`     | Allowed; returned CID, `image/png` MIME type, and size match the uploaded bytes        |
| `unrelated-blob-upload` | Denied with the exact HTTP 403 error in `scopeDenial`                                  |
| `release-create`        | Allowed; record references the returned package and image blobs                        |
| `release-readback`      | Allowed; public record contains the same blob CIDs, MIME types, and sizes              |
| `release-apply-update`  | Batched update denied with the exact HTTP 403 error in `scopeDenial`                   |
| `release-apply-delete`  | Batched delete denied with the exact HTTP 403 error in `scopeDenial`                   |
| `release-update`        | Denied with the exact HTTP 403 error in `scopeDenial`                                  |
| `release-delete`        | Denied with the exact HTTP 403 error in `scopeDenial`                                  |
| `profile-create`        | Denied with the exact HTTP 403 error in `scopeDenial`                                  |
| `unrelated-create`      | Denied with the exact HTTP 403 error in `scopeDenial`                                  |

The PDS report also includes:

- `scopeDenial`, the provider-specific HTTP status and error required for every denied probe;
- `blobs.package` and `blobs.image`, containing the returned CID, MIME type, and byte size; and
- `cleanup`, containing deletion outcomes only for forbidden profile or unrelated records that this harness run created.

If an allowed blob upload succeeds but release creation fails, the report retains the blob metadata. No cleanup call is available for that unreferenced blob; its PDS controls eventual garbage collection.

Do not commit raw evidence until it has been inspected for unexpected provider data. A reviewed summary matrix belongs in the RFC or implementation plan; sensitive OAuth state never does.

## Result matrix

| Provider            | Public-client scope        | Public-client refresh  | Public-client revocation                             | Confidential scope         | Confidential refresh | Revocation/key removal | Status             |
| ------------------- | -------------------------- | ---------------------- | ---------------------------------------------------- | -------------------------- | -------------------- | ---------------------- | ------------------ |
| Bluesky PDS at npmX | Pending blob-enabled rerun | Prior record-only pass | Prior record-only pass; token rejected immediately   | Pending service deployment | Pending              | Pending                | Blob rerun pending |
| Cirrus              | Pending blob-enabled rerun | Prior record-only pass | Prior record-only pass; token remained valid briefly | Pending service deployment | Pending              | Pending                | Blob rerun pending |

### Retained public-client evidence

The earlier record-only redacted reports are retained outside the repository. Their SHA-256 hashes are:

| Provider | Phase     | SHA-256                                                            |
| -------- | --------- | ------------------------------------------------------------------ |
| npmX     | authorize | `87f1c3b59c881c3f94193f355bfa6d0bf43d0a46930689ccae8624288f19b9f0` |
| npmX     | refresh   | `287f689a8cbcdef7ac5994c45cc9c652cc999a36dce94d2412b0350d9a254ab4` |
| npmX     | revoke    | `77b7f63d5fa00d782dbacaa92c7a28d18c56061e6412b64faece935e217faada` |
| Cirrus   | authorize | `3a26efb59303d66d498352d39ce02a72091ee2e91b17f69070f454bafb4bf507` |
| Cirrus   | refresh   | `931ab715f2d4d96817c8647567f28936357206077c8f1076acff6c17aeedf96e` |
| Cirrus   | revoke    | `87af4eb32677e32405b619a38f12cee6020081cd4eabd37fe1a1ed4f002912c0` |

npmX invalidated the access token immediately after revocation. Cirrus confirmed server-side revocation and local session deletion while the previously issued access token remained usable during its existing lifetime. The latter is permitted: revocation prevents future refresh but does not require retrospective invalidation of every access token.

## G0 completion criteria

G0 is complete only when:

- the RFC names the active exact scope and rejects broad fallback;
- the RFC and service specification agree on actors, authentication, Durable Object ownership, asynchronous intents, policy, approval, and provenance;
- the public-client preflight passes on the npmX-hosted Bluesky PDS and Cirrus;
- the confidential-client scope and refresh run passes on both;
- explicit revocation and client-key removal observations are recorded for both;
- any implementation difference is resolved in code, the support matrix, or the RFC before support is claimed; and
- the reviewed result matrix contains links or hashes for the retained redacted evidence.

The current preparation is complete when the harness builds and passes local tests, the operator procedure is executable up to browser authorization, and both real-account runs are ready for the account owner.
