# Delegated release service

Status: Implemented locally; deployment conformance pending

Related design: [RFC PR #1870](https://github.com/emdash-cms/emdash/pull/1870)

## Summary

The delegated release service lets a plugin publisher authorize automated releases without placing an AT Protocol account credential in continuous integration. The publisher grants the service create-only access to the package-release collection and bounded blob-upload access. A GitHub Actions workflow authenticates to the service with OpenID Connect (OIDC), uploads its bundle and provenance to private staging, and submits the checksum-bound release. The service verifies those bytes, uploads the bundle to the publisher's PDS, and creates a blob-only release record. The workflow receives either the published release or an intent waiting for passkey approval.

The service is a delegated writer, not a registry or trust authority. It cannot edit package profiles, overwrite releases, serve public or long-lived artifacts, moderate listings, or make an invalid release installable. EmDash installers independently verify the publisher's records, artifact, manifest, provenance, and signed package policy.

Canonical service state is sharded across SQLite-backed Durable Objects. A `PublisherDurableObject` owns each publisher's delegations, workload policies, release intents, reservations, and audit history. An `ApproverDurableObject` owns each approver's passkeys and challenges. A small `ServiceControlDurableObject` owns global pause and key-version state. Cloudflare Workflows orchestrate long-running verification and approval waits but do not replace the Durable Objects as the source of truth.

## Goals

- Publish an immutable sandboxed-plugin release from GitHub Actions without a stored AT Protocol credential in the runner.
- Restrict the service's durable AT Protocol grant to creating records in the active release collection.
- Bind every automated release to its source repository, workflow, commit, artifact, and provenance.
- Require a user-verified passkey decision when signed package policy requires confirmation or declared access expands.
- Preserve publisher ownership of package policy and approver membership in the publisher's PDS.
- Let an EmDash installer reject invalid service output without consulting or trusting the service.
- Provide a hosted service and the same Workers-based application for self-hosting.
- Support operator incident response through a Cloudflare Access-protected admin surface without giving operators publisher authority.

## Non-goals

- Native-plugin distribution.
- Public or long-lived artifact or provenance hosting.
- Plugin-listing or metadata moderation.
- Code-quality or malware assessment beyond canonical bundle, manifest, and provenance verification.
- Editing package profiles from the release service.
- Non-GitHub workload issuers in the first release.
- Quorum approval or signed approval receipts verifiable by installers.
- Generic user-defined OIDC claim expressions.
- Billing, organization management, or a general-purpose CI platform.
- Making the aggregator authoritative for publisher records, policy, or provenance.

## Actors and authentication

The service has three external authentication mechanisms. Credentials from one mechanism never authorize another.

| Actor                     | Authentication                                         | Authority                                                                                         |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| GitHub Actions workflow   | GitHub Actions OIDC                                    | Request publisher approval for its identity, then submit release intents                          |
| Atmosphere account holder | AT Protocol OAuth plus an enrolled passkey when needed | Establish or revoke delegation, confirm a GitHub workflow, and approve or reject an exact release |
| Service operator          | Cloudflare Access                                      | Observe, pause, suspend, revoke, retry, and recover the service                                   |

Cloudflare Access protects `/admin/*` and the operator API. The Worker verifies the `Cf-Access-Jwt-Assertion` signature, team issuer, role-specific audience, time claims, token type, and human identity. Access-injected identity headers and the browser cookie are not sufficient by themselves. Operator mutations retain CSRF and idempotency protection.

Deployments use separate Access policy and audience boundaries for three service roles:

- `viewer` reads health, publisher state, intent state, and sanitized audit data;
- `reviewer` cancels unpublished intents and triggers bounded reconciliation; and
- `admin` changes service mode, suspends publishers, revokes retained authority, and operates key or recovery controls.

Role names and audience bindings are stable application contracts. Each deployment assigns its operator groups to the appropriate Access policies; Access evaluates membership before forwarding the request. The Worker does not authorize from optional group claims because Access may trim custom claims to fit its cookie limit. No Access role can establish publisher delegation, authorize workload policy, enrol an approver, approve an intent, or publish a release.

One identity-only OAuth flow proves control of an Atmosphere account and issues short-lived publisher and approver application sessions. The separate cookies and Durable Objects preserve the internal authority boundaries without requiring two user logins. Application sessions cannot write to the PDS. The separately authorized release delegation is encrypted and stored in the publisher's Durable Object.

GitHub Actions OIDC tokens are audience-bound to the service. The service persists normalized claims and token identifiers, not the raw token.

## Security invariants

The implementation must preserve these invariants:

1. CI never receives or stores an AT Protocol refresh token, DPoP key, app password, or delegated release session.
2. The delegated grant is the exact scope returned by `getDelegatedReleasePermission()` from `@emdash-cms/registry-lexicons`: create-only release-record authority plus gzip-package and image-blob uploads.
3. The service never requests or stores package-profile write scope.
4. The delegated path exposes no update or delete operation for a release record.
5. A package version maps to one deterministic record key and one reservation in the publisher shard.
6. Publisher records are read directly from the DID-resolved PDS. Aggregator output is never an authority input.
7. Supplied HTTPS artifact and provenance bytes pass the shared SSRF-safe fetcher and their signed checksums. Publication replaces every artifact URL with a checksum-bound PDS blob; the final artifact descriptors contain no source URL.
8. Record, bundle, manifest, provenance, workload, policy, and access checks run after submission and again immediately before publication.
9. Human approval cannot override failed verification. It authorizes only a valid release that policy requires a human to confirm.
10. Approval is bound to the intent, workload claims, profile CID, baseline release CID, artifact and provenance checksums, declared-access diff, approver DID, and decision.
11. Passkey approval requires WebAuthn user verification, not only user presence.
12. A listed but unenrolled DID cannot approve. Enrolment and approval are separate ceremonies.
13. An Access operator can remove or suspend authority but cannot create publisher authority, edit signed policy, enrol an approver, or approve a release.
14. Durable Object state and a PDS write are never treated as one transaction. Ambiguous writes are reconciled by reading the deterministic key.
15. OAuth sessions, DPoP keys, emails, and future webhook secrets are application-encrypted before persistence.
16. Workflows, projections, and notification queues are recoverable coordination or read models, not canonical authorization state.

## Protocol contracts

### Delegated permission

The active release collection and OAuth scope come from `@emdash-cms/registry-lexicons`:

```ts
const permission = getDelegatedReleasePermission();
// permission.collection identifies the release NSID.
// permission.scope grants only create access to that collection.
```

The service does not hard-code the experimental or future stable NSID. A namespace migration requires a new publisher grant because AT Protocol repository scope is collection-specific.

The first release requests this granular permission directly rather than wrapping it in an AT Protocol permission set. Permission sets are useful when an application needs many permissions under one Lexicon namespace; this service needs one create-only repository permission. Direct scope keeps the effective authority visible in client metadata, stored delegation state, audit output, and conformance evidence. A future permission-set alias is acceptable only if every supported PDS resolves it to the identical collection and `create` action and the full authorization, refresh, and revocation matrix is repeated.

The initial support matrix contains:

- Bluesky PDS software hosted by npmX (`npmx.social`); and
- Cirrus.

Disposable accounts are available for both implementations. Credentials and recovery material remain outside the repository. Neither implementation is advertised as supported until its conformance run passes.

The supported-PDS matrix must prove that each claimed implementation:

- accepts a create in the release collection;
- rejects an update to the created release;
- rejects deletion through the delegated path;
- rejects profile writes and writes to unrelated collections;
- supports refresh and explicit revocation as claimed by the service; and
- stops accepting refreshed authority after revocation and client-key removal according to the authorization server's documented behavior.

There is no broad-scope fallback.

### Signed package profile policy

The package profile extension supplies the publisher-controlled policy:

```ts
interface PackageProfileExtension {
	repository: string;
	releasePolicy?: {
		requireProvenance?: boolean;
		confirmation?: "escalation-only" | "always";
		approvers?: string[];
	};
}
```

The service normalizes omitted values to the protocol defaults. It validates the repository as a canonical HTTPS source URL and every approver as a DID. The release service can display this policy but cannot change it.

The delegated path always requires supported provenance, even when `requireProvenance` is absent. The profile field communicates the publisher's requirement to every installer and non-delegated publisher. A supplied unsupported predicate is present-but-unverifiable and fails delegated publication.

### Signed release provenance

The release extension identifies the provenance document and the source it must describe:

```ts
interface ReleaseProvenance {
	predicateType: string;
	url: string;
	checksum: string;
	sourceRepository: string;
	builderId: string;
}
```

The first release understands SLSA provenance v1 in a Sigstore bundle. The provenance checksum covers the fetched provenance document. Its subject digest covers the package artifact. The source repository and builder identity must agree with the signed package profile, registered workload policy, GitHub OIDC claims, and provenance statement.

### Service-local workload policy

The publisher authorizes a service-local workload policy after proving the publisher DID:

```ts
interface GitHubWorkloadPolicy {
	publisherDid: string;
	packageSlug: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	allowedRefs?: string[];
	allowedEnvironments?: string[];
	active: boolean;
	stateVersion: number;
}
```

Repository and owner IDs preserve the authorization boundary across GitHub renames or name reuse. This policy narrows who may submit an intent. It cannot weaken the signed package policy or change publisher records.

Ref restrictions are exact by default. The only wildcard form is a trailing `*` under `refs/heads/` or `refs/tags/`; workflow repository and file paths remain exact. Choosing all version tags stores `refs/tags/*` for the trigger ref and only applies the same suffix to the workflow source ref when that source is also tag-based.

## Architecture

```text
GitHub Actions                         Publisher or approver browser
      | OIDC                                      | AT Protocol OAuth
      |                                           | WebAuthn when approving
      v                                           v
+---------------------------------------------------------------------+
| Release-service Worker                                             |
| Public API, publisher UI, approver UI, Access-protected admin      |
+--------------+--------------------+--------------------+-------------+
               |                    |                    |
               v                    v                    v
       PublisherDurableObject  ApproverDurableObject  ServiceControlDO
          publisher DID shard    approver DID shard      service shard
               |
               | intent ID
               v
       ReleaseIntentWorkflow -------> isolated verifier Worker
               |                              |
               |                              v
               |                     artifact/provenance hosts
               v
      private R2 staging -----> publisher PDS blobs and release record

Operational projections:
  OAuth callbacks -> 256 IdentityDirectoryDurableObject shards
  DO snapshots and audit exports -> R2
```

### Release-service Worker

The stateless Worker owns HTTP concerns:

- route and method dispatch;
- request parsing and size limits;
- authentication-realm selection;
- Access JWT, application session, CSRF, OIDC, and idempotency checks;
- deterministic routing to Durable Objects;
- static publisher, approver, and operator assets;
- public health responses that expose no tenant data; and
- stable API error envelopes and request IDs.

Business state transitions live in Durable Object RPC methods, not route handlers.

### `PublisherDurableObject`

The Worker routes with `getByName(canonicalPublisherDid)`. The DID is the coordination atom because one AT Protocol session and PDS serialize authority for all packages owned by that publisher.

The object owns:

- publisher status and tenancy;
- encrypted delegated OAuth session and key version;
- workload policies;
- release intents and immutable transition history;
- package/version reservations;
- immutable publication materialization plans, staged-object bindings, blob receipts, and final record JSON;
- OIDC and request idempotency;
- refresh and publication operation tokens;
- publisher-scoped audit events; and
- publisher-session revocation epochs.

SQLite constraints enforce uniqueness for package/version reservations, workload-policy identity, intent idempotency, and transition sequence numbers. RPC methods perform synchronous SQLite transactions for related state changes. The object never holds `blockConcurrencyWhile()` across an external request.

Slow external work uses a persistent operation-token protocol:

```text
Workflow -> beginPublication(intentId)
PublisherDO -> transition to publishing; return generation-bound token
Workflow -> refresh session and call the PDS
Workflow -> completePublication(token, result)
```

Only the current token can complete the operation. The object schedules its one alarm for the earliest refresh, publication, expiry, or cleanup deadline. The alarm marks abandoned operations for reconciliation and schedules the next pending deadline.

### `ApproverDurableObject`

The Worker routes with `getByName(canonicalApproverDid)`. The object owns:

- identity-proof transactions;
- enrolled WebAuthn credentials;
- credential names, counters, transports, creation, last use, and revocation;
- approval challenges bound to an approval digest;
- challenge expiry and single-use state; and
- approver-scoped audit events.

The object verifies a passkey decision and returns a receipt containing the approver DID, intent ID, digest, decision, credential ID, and verification time. The publisher object stores the receipt against the intent. Cross-object calls are replay-safe but are not treated as one transaction. Final verification checks that the approver DID is still authorized by the current profile.

### `ServiceControlDurableObject`

One low-traffic object owns:

- service mode: `active`, `admission-paused`, or `publication-paused`;
- active and readable encryption-key versions;
- hosted-service publisher allowlist or suspension defaults;
- operator mutation idempotency; and
- global operational audit events.

Intent admission checks the service mode. Every publication obtains a fresh publication permit immediately before the PDS write. A cached permit cannot authorize publication.

### Release Workflow

One Workflow instance orchestrates one intent. The instance ID is derived from the immutable intent ID. Step names are deterministic. Each step either reads or commits its result through the publisher object before proceeding.

The Workflow owns:

- durable retry timing;
- isolated verification steps;
- waiting for approval, rejection, cancellation, or expiry;
- OIDC-authorized workflow uploads, guarded external-source staging, PDS blob upload, and durable materialization;
- publication and ambiguous-write reconciliation; and
- non-critical completion fan-out.

The Workflow does not own the authoritative intent state. If Workflow state is lost after its retention period, the publisher object and audit history remain sufficient to determine the release state and start recovery.

### Verifier Worker

The verifier is a separate Worker reached through a service binding. It has no publisher OAuth binding, operator authentication secret, or Durable Object namespace. It:

- fetches artifacts and provenance through the shared guarded fetcher;
- enforces redirect, DNS, protocol, time, and size policy;
- validates checksums and canonical bundle structure;
- reconciles the bundled manifest with the proposed record;
- verifies supported Sigstore/SLSA provenance; and
- returns a bounded, serializable report without artifact bytes or secrets.

The service stages workflow-produced artifacts privately. It promotes verified provenance to immutable service storage before publishing its stable URL.

### Sharded identity directory

Cross-publisher inventory uses 256 `IdentityDirectoryDurableObject` shards selected by a digest of the canonical DID. Successful publisher and approver OAuth callbacks register only the DID, actor kind, and timestamps.

The directory is a non-authoritative projection. It excludes OAuth material, approval details, OIDC claims, emails, WebAuthn credentials, package policy, and release state. All operator reads that affect a decision query the authoritative publisher or approver object, and every mutation routes directly to that object.

The directory can be deleted and rebuilt as identities authenticate again without changing authorization or release outcomes.

### R2 staging, backup and audit export

The private `PUBLICATION_STAGING` bucket holds checksum-verified workflow uploads and publication artifacts while the Workflow uploads them to the publisher's PDS. Object keys bind the publisher, stable workload identity, package, version, and artifact slot. The Workflow deletes transient objects after all blob receipts and the canonical final record are committed in the publisher object. Seven-day lifecycle rules remove abandoned `workload/` and `publication/` objects after interrupted Workflows. Staging objects are never public, authoritative, or referenced by the published record.

The private `PROVENANCE_STORE` bucket holds provenance that passed initial and final verification. Objects use checksum-addressed, create-only keys. `GET /v1/provenance/{checksum}` streams only promoted objects with immutable caching; the transient staging bucket has no public read route.

Encrypted publisher snapshots and append-only audit exports may be written to the separate `OPERATIONS_ARCHIVE` bucket. Snapshot production must be bounded and resumable. A restore never revives expired or revoked authority automatically. If an OAuth session cannot be restored safely, the publisher reauthorizes delegation.

## Durable Object schemas

The following schemas describe required data and constraints. Exact SQL belongs with the implementation.

### Publisher shard

| Table                               | Required properties                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisher`                         | One row; DID, status, creation time, suspension reason code, session epoch                                                                            |
| `delegations`                       | Encrypted session envelope, exact scope, PDS, client key ID, expiry, refresh metadata, encryption-key version, revocation state                       |
| `workload_policies`                 | Package slug, repository, workflow reference, ref/environment restrictions, active state, authorizing publisher identity                              |
| `intents`                           | ULID, package/version, state, Workflow ID, normalized OIDC claims, record inputs, verification summaries, approval digest, result URI/CID, error code |
| `intent_transitions`                | Intent ID, monotonic sequence, from/to state, actor realm and identity, reason code, timestamp                                                        |
| `release_reservations`              | Unique package/version, intent ID, reservation state                                                                                                  |
| `idempotency_keys`                  | Realm, key, request digest, intent/result reference, expiry                                                                                           |
| `publication_materializations`      | Intent-bound source digest, status, canonical blob-only record JSON and digest, timestamps                                                            |
| `publication_materialization_slots` | Artifact slot, source URL digest, checksum, R2 key, media metadata, immutable PDS blob receipt                                                        |
| `operations`                        | Kind, generation, attempt key, token hash, intent ID, phase, materialization digest, start/deadline, completion state                                 |
| `audit_events`                      | Monotonic sequence, event type, actor realm, actor identity, subject, public-safe payload, timestamp                                                  |
| `deadlines`                         | Kind, subject ID, scheduled time, generation                                                                                                          |
| `workflow_connection_invitations`   | One-time SHA-256 token hash, package slug, expiry, creation time                                                                                      |
| `workflow_connection_requests`      | ULID, mutation key, connection key, package slug, normalized OIDC claims, state, ref scope, expected policy version, expiry and timestamps            |

Sensitive values are encrypted individually with associated data binding the publisher DID, table, row identity, and key version. The database never stores an encryption master key.

### Approver shard

| Table                   | Required properties                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `approver`              | One row; DID, status, session epoch                                                  |
| `credentials`           | Credential ID, public key, counter, transports, name, creation, last use, revocation |
| `identity_transactions` | OAuth state hash, PKCE state, expiry, completion                                     |
| `approval_challenges`   | Challenge hash, intent ID, publisher DID, approval digest, expiry, consumed time     |
| `decisions`             | Idempotency key, intent ID, digest, decision, credential ID, verification time       |
| `audit_events`          | Monotonic sequence, event type, subject, public-safe payload, timestamp              |
| `deadlines`             | Challenge or session cleanup deadline and generation                                 |

### Service-control shard

| Table                  | Required properties                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `service_state`        | Current mode, epoch, reason code, Access operator identity, changed time               |
| `encryption_keys`      | Key version, status, activation and retirement metadata; never key material            |
| `publisher_controls`   | Publisher DID, allow/suspend state, reason code, operator identity, timestamp          |
| `operator_idempotency` | Mutation key, request digest, result, expiry                                           |
| `audit_events`         | Monotonic sequence, operator identity, action, subject, public-safe payload, timestamp |

## Release intent state machine

The canonical state machine is:

```text
received -> verifying -> verified
                         |       |
                         |       +-> ready -> publishing -> reconciling -> published
                         |
                         +-> awaiting_approval -> ready

Non-success terminals:
  invalid, rejected, cancelled, expired, failed, conflict
```

Allowed transitions are explicit. Compare-and-set transition methods take the expected state and generation. Unknown or repeated transitions return the stored result when idempotent and reject when the requested payload conflicts.

`failed` represents an exhausted service or dependency failure after valid input. `invalid` represents a permanent input, identity, policy, bundle, or provenance failure. Neither is manually approvable. `conflict` means the deterministic release key contains a different record.

## Publisher onboarding

1. The publisher signs in once with the Atmosphere account that owns the plugin.
2. The service resolves and verifies the publisher DID and PDS.
3. Hosted-service admission policy permits or rejects the publisher.
4. The publisher authorizes the exact delegated release scope for create-only release records and gzip-package and image-blob uploads.
5. The service verifies the returned grant and stores the encrypted session in the publisher object.
6. The publisher creates a 30-minute workflow connection invitation for the plugin and stores the one-time value as the `EMDASH_CONNECTION_INVITATION` GitHub Actions secret.
7. The permanent release Action runs in the intended GitHub Actions workflow. Its audience-bound OIDC token supplies the immutable repository and owner IDs, workflow file, ref, and environment.
8. When no matching workload policy exists, the publisher object atomically consumes the package-bound invitation, stores a short-lived workflow connection request, and returns a browser approval URL. The Action writes that URL to the job summary and waits.
9. The browser displays the human-readable repository, workflow file, branch or tag, and environment. For a tag-triggered release, the publisher chooses the current tag or all version tags. Confirmation creates the package-to-GitHub-workload policy; the OIDC request cannot create authority by itself. The publisher can reject a request without granting authority.
10. The service fetches and validates the signed package profile.
11. Profile-listed approvers use the same Atmosphere login and enrol passkeys before approving a release.
12. A dry-run submission verifies OIDC identity, request shape, service admission, and workload policy without reserving, rate-limiting, starting verification, or publishing a version. It does not fetch or validate the artifact or provenance document.

The publisher can revoke the delegation from the service or directly through the authorization server. The service treats refresh failure after revocation as terminal authority loss, not as a retry loop.

## Release submission

1. GitHub Actions builds and bundles the plugin.
2. GitHub Actions creates SLSA provenance for the exact bundle.
3. The Action requests or verifies its workflow connection with an OIDC token whose audience is the release service. A missing policy requires and consumes a publisher-created invitation before creating a pending request; a matching policy lets the run continue without an invitation.
4. After browser confirmation, the Action uploads the bundle and raw Sigstore file to private staging with fresh OIDC tokens. Each object is checksum-bound to the publisher, workload, package, version, and slot.
5. The Action submits the package, version, staged source references, checksums, and idempotency key. Artifact descriptors contain internal HTTPS references and no PDS blobs.
6. The Worker verifies request shape, OIDC signature and claims, and routes to the publisher object.
7. The publisher object verifies workload-policy admission, reserves package/version, creates the intent, and records normalized claims.
8. The object creates the Workflow instance using the intent ID.
9. The API returns the intent resource. Publication is always asynchronous even when it completes quickly.

The idempotency identity includes publisher DID, package, version, GitHub repository, workflow, run ID, and run attempt. Repeating the same request returns the existing intent. Reusing the identity with a different request digest returns `IDEMPOTENCY_CONFLICT`.

## Verification

The Workflow performs these checks in order:

1. Resolve the publisher DID and authoritative PDS.
2. Fetch the current package profile and record its CID.
3. Validate package identity, profile extension, canonical repository, policy, and approver DIDs.
4. Confirm the proposed release key is absent.
5. Select the highest-semver existing release as the access baseline, excluding the proposed key. Record its CID, or the empty baseline for the first release.
6. Ask the verifier Worker to fetch and validate the artifact.
7. Confirm bundle package, version, manifest, and declared access match the proposed release.
8. Ask the verifier to fetch and validate provenance.
9. Match the artifact digest, source repository, builder, workflow, commit, and relevant GitHub claims.
10. Compute the canonical declared-access diff against the baseline.
11. Resolve `confirmation: always` or escalation-only policy.
12. Persist a bounded verification report and its input CIDs/checksums.

A missing or invalid supported provenance document is `invalid`. Approval cannot change that result.

## Approval

If approval is required, the publisher object stores an approval digest and transitions to `awaiting_approval`. The Workflow waits for a decision event with a bounded expiry.

An approver:

1. signs in with an Atmosphere account, using the same identity flow as the account dashboard;
2. opens the release and reviews its plugin, repository, workflow, GitHub account, and permission changes, with protocol evidence available under technical details;
3. requests a challenge from the approver object;
4. signs the approval digest using an active, user-verified credential; and
5. submits `approve` or `reject` with an idempotency key.

The service accepts the receipt only if the current profile still lists the approver DID. A rejection is terminal. A cancellation or expiry invalidates outstanding challenges. A new profile CID, access baseline, artifact checksum, provenance checksum, or workload claim set creates a new digest and requires a new approval.

## Publication and reconciliation

Before publication, the Workflow repeats every authoritative read and verification step. It then:

1. reads workflow-uploaded artifacts from private R2 or fetches external URL sources through the guarded verifier path, then writes verified bytes to deterministic publication objects;
2. obtains a replay-stable, generation-bound publication operation from the publisher object;
3. refreshes the encrypted AT Protocol session if required and uploads each staged package or image as a PDS blob;
4. validates every returned blob against the source checksum, byte size, and media type, then persists immutable receipts and canonical blob-only record JSON in the publisher object;
5. promotes verified provenance to its immutable store and deletes transient R2 objects after durable materialization;
6. obtains and consumes a fresh publication permit, rechecks delegation, and moves the operation to `creating`;
7. creates the deterministic release record without an update path;
8. completes the operation with the confirmed URI and CID; or
9. enters reconciliation only when the `createRecord` result is ambiguous.

Reconciliation reads the deterministic release key directly from the PDS:

- an exact proof-verified semantic match completes publication with the authoritative CID;
- confirmed absence permits an idempotent create retry;
- a different record at the key transitions to `conflict`; and
- a transient inability to establish presence or absence remains `reconciling` with bounded retries and operator visibility.

The service never reports `published` from an HTTP status alone when the response may be ambiguous.

## Cancellation, revocation, and suspension

- CI may cancel its own intent before `publishing` using a fresh matching OIDC identity.
- The publisher may cancel an intent before `publishing` through its application session.
- An approver may reject but cannot cancel on behalf of the publisher.
- An Access operator may cancel or quarantine an intent for incident response but cannot transition it to `ready` or `published`.
- Publisher revocation blocks new intents and refresh, and publication checks revocation immediately before the write.
- Service pause is checked at admission and again before the write.
- A publisher suspension blocks all publisher shards without deleting audit or encrypted state.

Revocation does not remove an already published record. Record removal or yanking follows the registry protocol and publisher authority model outside this service.

## HTTP API

The public service API is versioned under `/v1`.

Health endpoints are outside the versioned API. `GET /health` is configuration-independent process liveness. `GET /ready` loads required configuration and checks the service-control shard, but returns no tenant or operational state.

### CI API

| Method and path                        | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `POST /v1/release-intents`             | Submit or replay an OIDC-authenticated intent                     |
| `POST /v1/release-intents/dry-run`     | Check OIDC and admission policy without creating an intent        |
| `POST /v1/workflow-connections`        | Request a connection using OIDC and a one-time invitation         |
| `GET /v1/release-intents/{id}`         | Read status using matching workload identity or publisher session |
| `POST /v1/release-intents/{id}/cancel` | Cancel before publication                                         |

### Publisher API

| Method and path                                               | Purpose                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /v1/publisher/session/authorize`                        | Start identity-only publisher authorization               |
| `GET /v1/publisher`                                           | Read publisher and delegation state                       |
| `POST /v1/publisher/delegation/authorize`                     | Start exact-scope delegation authorization                |
| `DELETE /v1/publisher/delegation`                             | Revoke retained authority                                 |
| `GET /v1/publisher/workloads`                                 | List package workload policies                            |
| `POST /v1/publisher/workloads`                                | Create or replace an authorized policy                    |
| `POST /v1/publisher/workflow-connection-invitations`          | Create a package-bound, 30-minute connection invitation   |
| `GET /v1/publisher/workflow-connections`                      | List pending workflow connection requests                 |
| `POST /v1/publisher/workflow-connections/{requestId}/confirm` | Confirm a request and create its workload policy          |
| `DELETE /v1/publisher/workflow-connections/{requestId}`       | Reject and clear a pending connection request             |
| `DELETE /v1/publisher/workloads/{packageSlug}`                | Disable a policy                                          |
| `GET /v1/publisher/workloads/{packageSlug}/approvers`         | Read approval readiness for DIDs in the signed profile    |
| `GET /v1/publisher/intents`                                   | List publisher intents with cursor pagination             |
| `GET /v1/publisher/audit`                                     | List publisher-scoped audit events with cursor pagination |

`POST /v1/workflow-connections` is the GitHub OIDC-authenticated endpoint used by the permanent Action and `release submit`. It returns an existing matching policy without requiring an invitation. For an unmatched workflow, it atomically consumes a valid package-bound invitation and records a pending request in the publisher shard. It cannot create a workload policy.

### Approver API

| Method and path                         | Purpose                           |
| --------------------------------------- | --------------------------------- |
| `POST /v1/approver/session/authorize`   | Start identity-only authorization |
| `GET /v1/approver/credentials`          | List active and revoked passkeys  |
| `POST /v1/approver/credentials/options` | Begin enrolment                   |
| `POST /v1/approver/credentials`         | Finish enrolment                  |
| `DELETE /v1/approver/credentials/{id}`  | Revoke one credential             |
| `GET /v1/approvals/{intentId}`          | Read approval-safe intent details |
| `POST /v1/approvals/{intentId}/options` | Create a digest-bound challenge   |
| `POST /v1/approvals/{intentId}`         | Approve or reject                 |

### Access operator API

The typed operator client uses these canonical paths:

| Method and path                                               | Minimum role | Purpose                                          |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------ |
| `GET /admin/api/status`                                       | viewer       | Read service mode and component health           |
| `GET /admin/api/directory`                                    | viewer       | List publisher or approver directory projections |
| `GET /admin/api/audit`                                        | viewer       | Query global or projected operational audit data |
| `GET /admin/api/publishers/{publisherDid}`                    | viewer       | Read authoritative publisher state               |
| `POST /admin/api/intents/{intentId}/cancel`                   | reviewer     | Stop an unpublished intent                       |
| `POST /admin/api/intents/{intentId}/reconcile`                | reviewer     | Trigger bounded reconciliation                   |
| `POST /admin/api/pause`                                       | admin        | Change admission or publication mode             |
| `POST /admin/api/publishers/{publisherDid}/suspend`           | admin        | Suspend or restore publisher admission           |
| `POST /admin/api/publishers/{publisherDid}/revoke`            | admin        | Revoke retained service authority                |
| `POST /admin/api/publishers/{publisherDid}/encryption/rotate` | admin        | Re-encrypt one page of publisher state           |
| `POST /admin/api/approvers/{approverDid}/encryption/rotate`   | admin        | Re-encrypt one page of approver state            |
| `POST /admin/api/publishers/{publisherDid}/archive`           | admin        | Produce one bounded publisher archive page       |
| `POST /admin/api/publishers/{publisherDid}/archive/start`     | admin        | Start a resumable publisher archive Workflow     |
| `POST /admin/api/publishers/{publisherDid}/restore/prepare`   | admin        | Validate an archive before restore               |
| `POST /admin/api/publishers/{publisherDid}/restore`           | admin        | Restore one validated archive page               |
| `GET /admin/api/encryption/keys`                              | viewer       | Read encryption-key lifecycle state              |
| `POST /admin/api/encryption/keys/activate`                    | admin        | Activate a configured encryption-key version     |
| `POST /admin/api/encryption/verify`                           | admin        | Start fleet verification for a retiring key      |
| `POST /admin/api/encryption/keys/{version}/retire`            | admin        | Retire a verified inactive key                   |

State-changing requests require content-type validation, CSRF where cookies are used, and idempotency keys. API errors expose stable codes and public-safe messages.

## Error model

At minimum, the API and Workflow use these error classes:

| Code                   | Meaning                                                     | Retry behavior                   |
| ---------------------- | ----------------------------------------------------------- | -------------------------------- |
| `AUTH_INVALID`         | Authentication or session proof failed                      | Permanent for request            |
| `ACCESS_DENIED`        | Verified actor lacks required role or ownership             | Permanent                        |
| `PUBLISHER_SUSPENDED`  | Hosted service or operator blocked the publisher            | Retry after state change         |
| `SERVICE_PAUSED`       | Admission or publication is paused                          | Retry after state change         |
| `DELEGATION_REQUIRED`  | No usable exact-scope session exists                        | Publisher must reauthorize       |
| `WORKLOAD_NOT_ALLOWED` | OIDC claims do not match active policy                      | Permanent until policy changes   |
| `IDEMPOTENCY_CONFLICT` | Same key was used with a different request                  | Permanent                        |
| `VERSION_RESERVED`     | Package/version belongs to another intent                   | Permanent or return owner intent |
| `RELEASE_EXISTS`       | Proposed deterministic key already exists                   | Permanent unless exact replay    |
| `PROFILE_CHANGED`      | Authoritative policy changed after verification or approval | Reverify and possibly reapprove  |
| `BASELINE_CHANGED`     | Access baseline changed                                     | Reverify and possibly reapprove  |
| `ARTIFACT_INVALID`     | Fetch, checksum, bundle, or manifest failed                 | Permanent for supplied input     |
| `PROVENANCE_INVALID`   | Provenance or workload binding failed                       | Permanent for supplied input     |
| `APPROVAL_REQUIRED`    | Valid release awaits human decision                         | Not an error state               |
| `APPROVAL_INVALID`     | DID, credential, challenge, digest, or UV failed            | Permanent for attempt            |
| `DELEGATION_REVOKED`   | Session was revoked or cannot refresh                       | Publisher must reauthorize       |
| `PDS_TRANSIENT`        | PDS result is retryable                                     | Workflow retry                   |
| `PDS_AMBIGUOUS`        | Create outcome is unknown                                   | Reconciliation                   |
| `RELEASE_CONFLICT`     | Deterministic key contains different data                   | Terminal conflict                |
| `INTERNAL_ERROR`       | Public-safe catch-all                                       | Operator-visible correlation ID  |

Provider payloads, tokens, secrets, raw assertions, private evidence, and stack traces never enter public errors or persistent generic error strings.

## Encryption and key management

Envelope encryption uses compact JSON Web Encryption (JWE) through `jose`. A versioned 256-bit master key from Secrets Store or an equivalent Worker secret binding acts as an `A256GCMKW` key-encryption key. Each value receives a fresh content-encryption key, and `A256GCM` encrypts the payload. Master keys are read inside request or RPC scope and are never logged or persisted.

Each compact JWE includes:

- the key-management and content-encryption algorithms;
- the master-key version and initial profile version;
- a wrapped content-encryption key;
- key-wrap and content-encryption nonces and authentication tags;
- ciphertext; and
- a critical SHA-256 context digest.

The protected header is authenticated as JWE associated data. Its context digest binds the deployment, publisher DID, object class, table, row identity, field purpose, and master-key version. Swapping ciphertext between publishers or fields fails authentication.

Routine rotation introduces a new active version, retains old versions for decryption, re-encrypts in bounded publisher-shard batches, verifies completion through audit/export data, and only then retires the old version. Emergency rotation pauses publication first. Missing key material fails closed and requires operator recovery; it never silently discards or recreates delegation.

## Audit and privacy

Every security-relevant state change appends an immutable audit event in the authoritative shard before returning success. Events name the actor realm (`oidc`, `publisher`, `approver`, `access`, or `system`), stable actor identity, action, subject, reason code, and timestamp.

Audit payloads may include normalized repository, workflow, package, version, public record identifiers, and digest prefixes. They exclude raw tokens, assertions, OAuth sessions, DPoP keys, email bodies, WebAuthn public-key material, and artifact contents.

Access operator views use the least detailed representation required for operations. Publisher and approver views cannot read another publisher's private intents or credentials.

## Listing moderation integration

Publishing and listing moderation remain independent:

1. The delegated service creates a valid release record.
2. The aggregator observes the record.
3. Metadata labellers assess the exact visible profile and release CIDs.
4. Default admin discovery requires the configured positive moderation labels.

The delegated service neither issues moderation labels nor bypasses the aggregator's visibility policy. A successfully published release may remain absent from default discovery while moderation is pending.

## Operations and recovery

The Access admin exposes service mode, publisher lookup, stuck operations, reconciliation, authority revocation, suspension, encryption-key status, Workflow status, and sanitized audit events.

Required runbooks cover:

- compromised service encryption key;
- compromised Access operator identity;
- publisher-requested revocation;
- authorization-server outage;
- PDS write ambiguity;
- Workflow loss or prolonged retry;
- verifier egress failure;
- Durable Object schema migration failure;
- lost or corrupt publisher shard;
- passkey compromise or counter anomaly; and
- hosted-service rollback.

Recovery prefers removal of authority. If encrypted session state cannot be proved correct, revoke or disable it and require publisher reauthorization.

## Compatibility and rollout

- The first deployment uses one complete initial Durable Object schema and one initial encryption profile. Implementation PR boundaries do not create schema versions or legacy ciphertext formats.
- Protocol additions remain optional while the registry is experimental.
- Interactive publisher-owned CLI publication continues to work.
- Existing releases without provenance remain installable unless signed package policy requires provenance.
- The delegated service itself always requires provenance for its releases.
- A stable release-collection namespace requires a fresh delegation grant.
- Old application versions tolerate the optional profile and release extension fields.
- After the first deployment, a rolling service update must tolerate shards at the previous application schema version until their forward migration completes.

## System acceptance criteria

The service is complete only when all of the following hold:

### Delegation and identity

- A publisher authorizes the exact delegated release grant on the Bluesky PDS implementation at npmX and on Cirrus.
- The retained session creates a new release and cannot update it, delete it, edit a profile, or write another collection.
- Revocation prevents new publication and eventual refresh; emergency service revocation removes retained authority.
- Cloudflare Access operators cannot reach publisher, approver, or CI-authorized actions.

### Workload and verification

- A configured GitHub workflow can submit an intent; a wrong repository, workflow, audience, ref, environment, run identity, or expired token cannot.
- Replaying the same request returns the same intent; changing the payload under the same idempotency identity fails.
- Artifact, bundle, manifest, declared access, provenance, source, builder, and commit substitution tests fail closed.
- The service reads authoritative profile and release records directly from the publisher PDS.

### Approval

- An ordinary non-escalating release publishes automatically under `escalation-only`.
- `confirmation: always` and declared-access expansion wait for approval.
- An unlisted, unenrolled, revoked, cloned, non-user-verified, or digest-mismatched credential cannot approve.
- Profile, baseline, artifact, provenance, or workload changes invalidate prior approval.
- Approval never converts invalid verification into a publishable release.

### Publication and recovery

- Concurrent submissions cannot claim the same publisher/package/version.
- OAuth refresh and PDS publication serialize within a publisher shard without holding a Durable Object-wide external-I/O lock.
- Every package and listing image is uploaded as a checksum-bound PDS blob, and the created release record contains blob references with no artifact source URLs.
- Blob receipts and the canonical final record are committed before a publication permit is issued or `createRecord` begins.
- Duplicate Workflow execution cannot create a second semantic release or duplicate a terminal transition.
- A timeout before, during, or after the PDS write converges to published, retryable absence, or conflict through reconciliation.
- Service pause and publisher suspension are enforced immediately before the write.

### Independent consumption

- A clean EmDash site independently accepts a valid delegated release.
- It rejects absent, malformed, mismatched, unsupported, or invalid required provenance even if the service marked the intent published.
- It rejects a bundle whose manifest differs from the signed release's declared access.
- Listing moderation remains required independently for default admin discovery.

### Platform and operations

- After the first deployment, Durable Object migrations preserve existing delegation, intent, credential, and audit data.
- Successful materialization removes its R2 staging objects, and the staging bucket lifecycle removes objects abandoned for seven days.
- Encryption-key rotation completes without losing authority or leaving values unreadable.
- Encrypted snapshots and audit exports restore into a fresh deployment without automatically reviving expired or revoked authority.
- Hosted and self-hosted deployments pass the same protocol and service conformance suite.
- External security review has no unresolved critical or high findings before production launch.
