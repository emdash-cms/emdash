# Delegated Release Service Implementation Spec

Status: implementation in progress; deployed-PDS validation is deferred to production conformance; Gate 0B complete

Source: [RFC PR #1870](https://github.com/emdash-cms/emdash/pull/1870), Attested Automated Publishing

This spec covers the complete feature: protocol records, shared verification, the hosted delegated release service, publisher and approver UI, CLI integration, install-time verification, and aggregator handling. The service is the center of the design, but it is not useful or safe unless the protocol and install-time work land with it.

## Decisions

| Area                 | Decision                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference runtime    | A standalone Cloudflare Workers app at `apps/release-service`, separate from the aggregator.                                                            |
| Canonical state      | D1. Use CAS state transitions, unique constraints, leases, and a transactional outbox.                                                                  |
| Durable Objects      | Do not use one in v1. A per-publisher DO is a later optimization for OAuth refresh and PDS write serialization if D1 lease contention becomes material. |
| Workload identity    | GitHub Actions OIDC in v1 behind an issuer-neutral verifier interface.                                                                                  |
| Management surface   | A full web console for service-local configuration and audit. Signed package policy remains read-only in the service.                                   |
| Approver credentials | Multiple named passkeys per approver DID, individually revocable.                                                                                       |
| Notifications        | Email and signed webhooks, both behind adapters.                                                                                                        |
| API style            | Versioned JSON HTTP API under `/v1`, not XRPC. Protocol records remain atproto lexicons.                                                                |
| Provenance predicate | SLSA provenance v1 is the only understood predicate in v1. Other predicates are present-but-unverifiable and fail when provenance is supplied.          |
| Approval threshold   | One valid approval from any currently listed, enrolled approver. Quorum is out of scope.                                                                |
| Stage TTL            | 24 hours by default, operator-configurable with a bounded range of 15 minutes to 7 days.                                                                |
| Service tenancy      | Multi-tenant by default. A v1 self-host deploys the same Worker app in its own Cloudflare account and can restrict allowed publisher DIDs.              |

## Implementation Baseline

The integration branch has implemented the RFC-derived profile and release contracts, extension-preserving profile writes, the local profile-policy command, and the shared verification foundations through production public Sigstore provenance verification. See implementation PRs #1915, #1918, #1920, #1925, #1929, #1932, #1937, #1943, and #1951.

The remaining external validation is split by impact:

- Service feasibility: confidential OAuth custody is compatible with workerd. Deployed-PDS compatibility is a conformance and production-smoke requirement, not a pre-implementation gate; the service still has no broad-scope fallback.
- History feasibility: select an event source that preserves verifiable intermediate profile values. This blocks historical aggregator enforcement and production launch, not the service or installer.

The next protocol/verification closure is two coherent merge units: exact scope plus create-only publishing (`W1.6` + `W1.7`), and direct-PDS reads plus structured record/policy verification (`W2.6` + `W2.7`).

## Non-Negotiable Security Invariants

1. CI never receives or stores an atproto account credential, refresh token, DPoP private key, or delegated release session.
2. The durable writer grant is exactly `atproto repo:<release-nsid>?action=create`. There is no `transition:generic` fallback.
3. The service never durably acquires profile write scope. The console reads signed package policy from the PDS but cannot change it.
4. A release version is create-only and immutable. The delegated path has no overwrite option.
5. Every decision is based on records fetched directly from the publisher PDS, not aggregator data.
6. Every supplied artifact and provenance document is fetched through the shared SSRF-safe fetcher and checked against its signed checksum.
7. Artifact, provenance, profile policy, and escalation checks run at submission and again immediately before the PDS write.
8. Human approval is bound to an approval digest covering the release, workload evidence, policy, profile CID, baseline release CID, approver DID, and action.
9. Passkey approval requires WebAuthn user verification, not only user presence.
10. A listed but unenrolled DID cannot approve. Enrolment and approval are separate ceremonies.
11. D1 state and a PDS write are never treated as one transaction. Ambiguous PDS results are reconciled by reading the deterministic record key.
12. Secrets at rest are application-encrypted. Database access alone must not expose OAuth sessions, DPoP keys, emails, or webhook secrets.

## Scope

### Included

- Profile policy and release provenance lexicon additions.
- A shared, Workers-compatible registry verification package.
- A standalone hosted release service with D1, Queues, cron, static assets, and a React console.
- Confidential atproto OAuth for durable release delegation.
- atproto login for publisher console sessions and approver DID proof.
- GitHub Actions OIDC policy registration and verification.
- Staged release lifecycle, passkey enrolment, approval, rejection, cancellation, and expiry.
- Multiple passkeys per approver DID.
- Email and webhook notifications.
- CLI commands and a reusable service API client.
- Install-time provenance and signed policy enforcement.
- Aggregator policy status, provenance verification, and downgrade history.
- Local workerd tests, browser WebAuthn tests, and an end-to-end test PDS flow.
- Cloudflare Workers self-hosting documentation and replaceable notification adapters.

### Excluded

- Native plugins.
- Non-GitHub workload issuers in the first release.
- Quorum approval.
- Signed approval receipts verifiable by installers.
- The future approver-addition cooldown.
- A profile-policy editor inside the release service.
- Artifact hosting or upload. CI supplies stable URLs.
- Generic configurable OIDC claim expressions in v1.
- A protocol-level recovery identity for lost approver passkeys.

## Required RFC Clarifications

These should be corrected in PR #1870 or recorded in a follow-up before implementation is called conforming.

### OAuth revocation is not immediate

Removing a confidential-client key from JWKS prevents sessions bound to that key from refreshing after the authorization server observes the removal. Existing access tokens remain usable until expiry. Emergency revocation must also call the authorization server's revocation endpoint for each known session. The service stores the client assertion key ID used to create each session so routine rotation can retain old public keys while those sessions exist.

### The service uses public PDS reads

Create-only repo scope grants writes, not reads. Package profiles and prior releases are public records and are read without the delegated session. Reads resolve the current PDS from the publisher DID and never use the aggregator as authority.

### Automated submission is asynchronous

Artifact and Sigstore verification can outlive a normal request and must survive retries. `POST /v1/release-intents` returns an intent resource. The GitHub Action and CLI poll or stream status until the result is `published` or `awaiting_approval`. A fast path may include the AT URI in the initial response, but callers cannot require it.

### "Previous release" needs a deterministic definition

For escalation evaluation, the baseline is the highest-semver existing release for the package at the time of verification, excluding the proposed `(package, version)` key. If no release exists, the baseline access is `{}`. This is deliberately conservative for out-of-order publication. The baseline is recomputed before publishing; a change invalidates an existing approval.

### Experimental and stable NSIDs

During the registry experiment the grant targets `com.emdashcms.experimental.package.release?action=create`. The service derives this from `@emdash-cms/registry-lexicons`; it must not hard-code the eventual `pm.fair.*` collection. Stable namespace migration requires every publisher to establish a new grant because OAuth scope is collection-specific.

### CLI binary name

The repository currently ships `emdash-plugin`, while the RFC examples say `emdash plugin`. Implementation and docs must settle on one public spelling. This spec uses the existing `emdash-plugin` binary.

## Architecture

```text
GitHub Actions                    Publisher / approver browser
      | OIDC                                  | atproto OAuth + WebAuthn
      v                                       v
+----------------------------------------------------------------+
| apps/release-service                                         |
| Worker API, React console, OAuth, OIDC, policy, orchestration |
+-----------------------------+----------------------------------+
                              |
                         D1 canonical state
                              |
                   transactional outbox rows
                              |
                 +------------+-------------+
                 |                          |
        validation/publish queue      notification queue
                 |                          |
        artifact host, Sigstore      Email Service, webhooks
                 |
          publisher PDS createRecord
```

The service is not part of `apps/aggregator`. The aggregator is public, read-oriented, and has no publisher capability. The release service is a security-sensitive control plane with encrypted credentials and private user data. They may share published libraries, not bindings, databases, or deployments.

### D1 Versus Durable Objects

#### D1-only

Benefits:

- One relational source for console queries, package policy, stages, credentials, audit, and deliveries.
- Unique constraints naturally reserve package versions and deduplicate OIDC tokens.
- D1 migrations, local workerd testing, and Queue patterns already exist in `apps/aggregator`.
- The relational model does not prevent a later SQLite or Postgres port, but v1 self-hosting targets Workers and D1.

Costs:

- OAuth refresh and publication need explicit leases because multiple Worker isolates may race.
- PDS writes remain external side effects and require reconciliation.

#### Durable Object authority

A per-publisher SQLite Durable Object would serialize token refreshes and PDS writes. It does not solve the PDS transaction boundary, and it fragments state needed by the global console, audit queries, approver views, and operator tooling. Adding a D1 projection would introduce a dual-write problem more dangerous than the race it removes.

#### Hybrid

A hybrid keeps D1 canonical and routes only publisher-session operations through a per-publisher DO. This is viable later if metrics show meaningful lease contention or repeated refresh races. The DO must remain an execution coordinator with rebuildable state, never the only copy of a grant or release lifecycle.

#### Decision

Ship D1-only. Implement `PublisherCoordinator` behind an interface so a later DO adapter can replace D1 leases without changing intent or API code.

```ts
interface PublisherCoordinator {
	withSessionLease<T>(publisherDid: string, operation: () => Promise<T>): Promise<T>;
	withPublishLease<T>(publisherDid: string, operation: () => Promise<T>): Promise<T>;
}
```

## Repository Layout

```text
apps/release-service/
  migrations/
  public/
  src/
    api/
    audit/
    console/
    crypto/
    db/
    intents/
    notifications/
    oauth/
    oidc/
    passkeys/
    publishing/
    queues/
    routes/
    index.ts
  test/
  package.json
  vite.config.ts
  vitest.config.ts
  wrangler.jsonc

apps/release-verifier/
  src/
    index.ts
  test/
  package.json
  vitest.config.ts
  wrangler.jsonc

packages/registry-verification/
  src/
    access.ts
    bundle.ts
    checksum.ts
    fetch.ts
    policy.ts
    provenance.ts
    records.ts
    index.ts
```

Changes also touch:

- `packages/registry-lexicons`: profile policy and provenance schemas.
- `packages/registry-client`: direct PDS read/create helpers and release-service API client.
- `packages/plugin-types`: canonical declared-access comparison and diff.
- `packages/auth`: optional required-UV WebAuthn verification and challenge context.
- `packages/plugin-cli`: delegate, policy, enrol, approve, and automated submit commands.
- `packages/core`: install-time provenance and profile policy enforcement.
- `apps/aggregator`: policy history, provenance verification, and discovery filtering.

## Protocol Changes

### Package profile extension

Add `com.emdashcms.experimental.package.profileExtension` and an `extensions` map on the package profile. The extension has this shape:

```ts
interface PackageProfileExtension {
	$type: "com.emdashcms.experimental.package.profileExtension";
	repository: string;
	releasePolicy?: {
		requireProvenance?: boolean;
		confirmation?: "escalation-only" | "always";
		approvers?: string[];
	};
}
```

Constraints:

- `repository` is a canonical HTTPS source repository URL, maximum 1024 bytes.
- `approvers` contains atproto DIDs only, has no duplicates, and is capped at 32.
- Absence normalizes to `requireProvenance: false`, `confirmation: "escalation-only"`, `approvers: []`.
- Unknown `confirmation` values fail lexicon or semantic validation.
- Policy fields stay optional for backwards compatibility.

The repository field belongs in the signed profile extension because provenance layer 4 needs a package-level source anchor. The existing per-release `repo` field may remain for FAIR compatibility but cannot replace the profile anchor.

### Release provenance

Extend the release extension:

```ts
interface ReleaseProvenance {
	predicateType: "https://slsa.dev/provenance/v1" | string;
	url: string;
	checksum: string;
	sourceRepository: string;
	builderId: string;
}

interface PackageReleaseExtension {
	$type: "com.emdashcms.experimental.package.releaseExtension";
	declaredAccess: DeclaredAccess;
	provenance?: ReleaseProvenance;
}
```

The provenance document is a Sigstore bundle. `checksum` covers the exact fetched document bytes. The attestation subject digest covers the package artifact bytes.

### Lexicon rollout

1. Add JSON lexicons and semantic validators.
2. Regenerate types with the existing registry-lexicons generation command.
3. Add round-trip fixtures before publishing schemas.
4. Update the experimental permission set, if one is published, to include the exact create-only collection.
5. Test scope support against Bluesky's PDS and at least one alternative PDS before service beta.

Update every existing profile writer at the same time. In particular, `packages/plugin-cli/src/publish/api.ts` currently reconstructs profiles from a whitelist when updating `lastUpdated`; `ProfileInput`, `buildProfileRecord`, `stampLastUpdated`, and related validation must preserve `extensions` byte-for-byte unless `emdash-plugin policy` intentionally changes it. Add a regression test that sets strict policy, performs a later interactive publish, and proves the profile extension and CID-derived policy survive.

## Shared Verification Package

`@emdash-cms/registry-verification` is runtime-neutral ESM and must run in Workers and Node. It is the only implementation used by the service, installer, and eventually the CLI and aggregator.

### Safe fetching

`fetchVerifiedResource()` enforces:

- HTTPS only.
- No URL credentials.
- Manual redirects, maximum 3.
- Reject IP literals and local/internal hostname forms. Pre-resolve DNS and reject loopback, private, link-local, multicast, unspecified, and metadata ranges before every hop as defense in depth.
- A response header timeout, total timeout, and byte limit.
- Streaming reads that abort on the first byte over the limit.
- No forwarding of authorization, cookies, or caller headers across origins.
- Content length is an early rejection only; the stream limit remains authoritative.
- Injected `fetch` and resolver for deterministic tests.

Artifact and provenance hosts are untrusted. The same restrictions apply to webhook registration probes and redirects.

Workers `fetch()` does not expose or pin the IP used for the actual connection, so DNS pre-resolution cannot eliminate rebinding TOCTOU. The hosted deployment performs untrusted fetches in `apps/release-verifier`, a dedicated Worker reached through a narrow release-service binding, with no public route, outbound service bindings, D1, Queues, service secrets, VPC connectivity, credentials, or private origin access. If a deployment exposes private network connectivity, it must route these requests through an egress proxy that resolves, validates, and pins the destination. The threat model and self-hosting docs state this residual explicitly.

### Checksum handling

Exports:

```ts
computeMultihash(bytes, algorithm);
decodeMultihash(value);
verifyMultihash(bytes, expected);
compareDigestBytes(left, right);
```

The delegated path accepts multibase multihashes only. Legacy bare hexadecimal checksums may remain install-compatible for old records but are rejected for new delegated releases.

### Bundle verification

Consolidate the currently different readers in `packages/plugin-cli/src/commands/publish.ts` and `packages/core/src/plugins/marketplace.ts`.

The canonical reader:

- Rejects absolute paths, `..`, normalized-path collisions, duplicate entries, links, devices, and unsupported entry types.
- Requires exactly one root `manifest.json` and one root `backend.js`.
- Enforces compressed, decompressed, file-count, and per-file limits from one exported constants module.
- Parses `manifest.json` with the shared plugin manifest schema.
- Requires manifest slug and version to match the intent.
- Returns canonical `declaredAccess`, never raw manifest capability sugar.

### Declared access escalation

Add these exports to `packages/plugin-types/src/declared-access.ts` and re-export from `@emdash-cms/plugin-types`:

```ts
canonicalizeDeclaredAccess(value): CanonicalDeclaredAccess
declaredAccessEqual(previous, next): boolean
diffDeclaredAccess(previous, next): AccessDiff
isDeclaredAccessEscalation(previous, next): boolean
```

Rules:

- Materialize implied operations, such as write implying read.
- Sort object keys and sort/deduplicate host lists.
- Adding a category or operation is escalation.
- Removing a category or operation is narrowing.
- Missing `network.request.allowedHosts` means unrestricted access.
- Restricted to unrestricted network access is escalation.
- A new host is escalation unless an old exact or wildcard pattern already covers it.
- `*.example.com` covers subdomains, not `example.com` itself.
- Removing a known restricting constraint is escalation.
- Any changed unknown constraint is conservatively escalation because narrowing cannot be proved.
- The first release compares against empty access.
- The result includes a structured, localized-UI-friendly diff, not preformatted English.

### Provenance verification

```ts
interface ProvenanceVerifier {
	verify(input: {
		document: Uint8Array;
		reference: ReleaseProvenance;
		artifactDigest: Uint8Array;
		profileRepository: string;
	}): Promise<VerifiedProvenance>;
}
```

The GitHub/Sigstore implementation verifies:

1. The reference checksum matches the fetched Sigstore bundle.
2. The Sigstore signature, certificate chain, identity, and transparency evidence are valid under current Sigstore trust roots.
3. The attestation predicate is SLSA provenance v1.
4. A subject digest exactly matches the package artifact digest.
5. The attested source repository canonicalizes to `sourceRepository` in the release reference.
6. `sourceRepository` canonicalizes to the signed profile `repository`.
7. The verified GitHub workflow identity exactly matches `builderId` using the authoritative identity fields in the Sigstore certificate and SLSA predicate.

The implementation must not do partial verification. Unknown predicates and unsupported bundle formats produce `PROVENANCE_UNVERIFIABLE`, never "absent".

W0.5 proved public Sigstore verification in workerd with a real `actions/attest-build-provenance` bundle and documented the exact repository, workflow, commit, certificate, SLSA builder, and RFC `builderId` mapping. W2.5 then landed production verification with a vendored trust root, real fixture, packed-output workerd coverage, and a version-pinned `@sigstore/core` key-aware algorithm patch. The implementation fails closed and does not delegate cryptographic verification to an external trust API.

## Service Data Model

All IDs are ULIDs. Timestamps are UTC ISO strings. JSON columns contain canonical JSON where hashes or comparisons depend on them.

### Identity and delegation

`publisher_accounts`

| Column                     | Notes                                        |
| -------------------------- | -------------------------------------------- |
| `did`                      | Primary key.                                 |
| `handle`                   | Display cache only.                          |
| `pds_url`                  | Resolved cache, never a permanent authority. |
| `pds_resolved_at`          | Cache timestamp.                             |
| `created_at`, `updated_at` | Audit metadata.                              |

`delegations`

| Column                                   | Notes                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `id`                                     | Primary key.                                                               |
| `publisher_did`                          | Unique active delegation per DID and release NSID.                         |
| `release_nsid`                           | Scope-bound collection.                                                    |
| `encrypted_session`                      | atcute token set, authentication method, and per-session DPoP private key. |
| `encryption_key_version`                 | Enables envelope-key rotation.                                             |
| `client_key_id`                          | Confidential client assertion key that created the session.                |
| `scope`                                  | Must equal the expected exact scope.                                       |
| `status`                                 | `active`, `refreshing`, `reauthorization_required`, `revoked`.             |
| `lease_owner`, `lease_expires_at`        | Distributed refresh lock.                                                  |
| `last_refreshed_at`, `refresh_before`    | Proactive refresh schedule.                                                |
| `created_at`, `updated_at`, `revoked_at` | Lifecycle.                                                                 |

`console_sessions` stores an opaque hashed browser session token, publisher DID, expiry, and CSRF secret. The atproto identity OAuth session is discarded after login; console authentication does not need durable PDS access.

`oauth_transactions` stores hashed state, PKCE material, purpose, expected DID, client assertion key ID, encrypted temporary state, redirect target, and expiry. Purposes are `console_login`, `release_delegation`, and `approver_identity`.

### Workload policy

`workload_policies`

| Column                                       | Notes                                                    |
| -------------------------------------------- | -------------------------------------------------------- |
| `id`                                         | Primary key.                                             |
| `publisher_did`, `package_slug`              | Unique package mapping.                                  |
| `provider`                                   | `github-actions` in v1.                                  |
| `issuer`                                     | Exact issuer URL.                                        |
| `audience`                                   | Exact service audience.                                  |
| `repository_id`, `repository_owner_id`       | Immutable GitHub identifiers, required.                  |
| `repository`                                 | Human-readable `owner/name`, checked in addition to IDs. |
| `workflow_ref`                               | Exact reusable workflow or workflow file identity.       |
| `allowed_refs`                               | JSON list of exact refs or validated prefix patterns.    |
| `allowed_environments`                       | Optional JSON allowlist.                                 |
| `enabled`                                    | Boolean.                                                 |
| `version`                                    | Increments on every edit and is captured by an intent.   |
| `created_by_did`, `created_at`, `updated_at` | Audit.                                                   |

Policies do not accept arbitrary JavaScript or expression languages. The console presents typed fields. A package may have multiple policies, for example release and prerelease workflows.

`workload_token_uses` has a primary key over `(issuer, token_hash)`, expiry, intent ID, and first-seen timestamp. Hash the complete raw JWT so replay protection does not depend on an optional `jti` claim.

### Approvers and passkeys

`approver_identities`

| Column                     | Notes                                |
| -------------------------- | ------------------------------------ |
| `did`                      | Primary key.                         |
| `handle`                   | Display cache.                       |
| `encrypted_email`          | Optional private notification route. |
| `email_verified_at`        | Null until verified.                 |
| `created_at`, `updated_at` | Lifecycle.                           |

`approver_credentials`

| Column                                             | Notes                                 |
| -------------------------------------------------- | ------------------------------------- |
| `credential_id`                                    | Primary key, base64url credential ID. |
| `approver_did`                                     | Owner.                                |
| `name`                                             | User-provided authenticator label.    |
| `public_key`, `algorithm`, `counter`, `transports` | WebAuthn verification data.           |
| `device_type`, `backed_up`                         | Display and risk metadata.            |
| `created_at`, `last_used_at`, `revoked_at`         | Lifecycle.                            |

`enrolment_invitations` stores a random-token hash, target DID, optional publisher/package context, expiry, consumed time, and inviter DID. Possession does not authorize enrolment; OAuth must return the same target DID.

`webauthn_challenges` stores only the challenge hash plus purpose, approver DID, credential restrictions, intent ID, approval digest, profile CID, baseline release CID, action, expiry, and consumed timestamp.

### Release lifecycle

`release_targets` reserves immutable versions.

| Column                                     | Notes                                   |
| ------------------------------------------ | --------------------------------------- |
| `publisher_did`, `package_slug`, `version` | Composite primary key.                  |
| `record_digest`                            | Canonical proposed release record hash. |
| `intent_id`                                | Owning intent.                          |
| `at_uri`, `cid`                            | Populated on publication.               |

`release_intents`

| Column                                                                 | Notes                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `id`                                                                   | Primary key.                                                       |
| `publisher_did`, `package_slug`, `version`, `rkey`                     | Release identity.                                                  |
| `idempotency_key`                                                      | Unique per workload policy.                                        |
| `record_json`, `record_digest`                                         | Immutable canonical release draft.                                 |
| `approval_digest`                                                      | Hash of every fact displayed and authorized by a passkey approval. |
| `artifact_digest`                                                      | Raw digest representation for provenance comparison.               |
| `workload_policy_id`, `workload_policy_version`                        | Policy used at submission.                                         |
| `workload_evidence`                                                    | Canonical verified claims, never the raw bearer token.             |
| `profile_cid`, `profile_policy_json`, `profile_policy_digest`          | Submission snapshot.                                               |
| `baseline_release_uri`, `baseline_release_cid`, `baseline_access_json` | Escalation baseline.                                               |
| `access_diff_json`, `is_escalation`                                    | Approval presentation and decision.                                |
| `requires_approval`                                                    | Derived from signed profile policy plus escalation.                |
| `status`, `state_version`                                              | CAS state machine.                                                 |
| `expires_at`                                                           | Stage TTL.                                                         |
| `lease_owner`, `lease_expires_at`                                      | Queue consumer lease.                                              |
| `at_uri`, `release_cid`                                                | Publication result.                                                |
| `failure_code`, `failure_detail`                                       | Stable machine code plus safe detail.                              |
| `created_at`, `updated_at`, `published_at`                             | Lifecycle.                                                         |

The approval digest is not the release record digest. It is a domain-separated hash over canonical release record JSON, artifact and provenance references, derived declared access, normalized verified workload evidence, workload policy ID and version, profile CID and policy digest, baseline release CID and access, approver DID, and action. Recompute it when issuing and consuming a challenge. Any mismatch invalidates the challenge.

`intent_approvals` stores intent ID, approver DID, credential ID, approval digest, profile CID, baseline release CID, approved/rejected action, and timestamp. It is append-only.

### Delivery and audit

`notification_endpoints` has an explicit `publisher_did` owner, endpoint type, optional `approver_did` recipient, encrypted destination, verification state, event allowlist, enabled state, and last failure. Webhook rows also store an encrypted signing secret. Every management and delivery query includes the owner key; ownership is never inferred from an event payload.

`outbox_events` stores event ID, type, canonical payload, destination class, creation time, enqueue time, and completion time.

`delivery_attempts` has a unique key `(event_id, endpoint_id, attempt)`, HTTP status or mail result, retry time, and redacted error.

`audit_events` is append-only and contains actor type, actor identifier, action, target type/ID, request ID, IP prefix or privacy-preserving hash, structured safe metadata, and timestamp. Never log JWTs, OAuth state, session blobs, passkey challenges, email addresses, or webhook secrets.

## Release Intent State Machine

```text
received
  -> validating
       -> awaiting_approval
       -> publish_queued
       -> failed

awaiting_approval
  -> publish_queued
  -> rejected
  -> cancelled
  -> expired
  -> validating       profile/baseline changed and must be re-evaluated

publish_queued
  -> publishing
       -> published
       -> publish_queued   transient failure after confirmed absence
       -> conflict         different record exists at deterministic rkey
       -> failed           permanent verification or auth failure
```

Every transition uses a conditional update on `(id, status, state_version)`. Queue messages carry only intent ID and expected state version. A consumer that loses the CAS does no external work.

Terminal statuses are `published`, `rejected`, `cancelled`, `expired`, `conflict`, and `failed`.

### Submission transaction

1. Verify the GitHub JWT and workload policy before fetching user-controlled URLs.
2. Validate and canonicalize the release draft.
3. Hash the raw JWT and canonical record.
4. Use one D1 batch to insert the token-use row, reserve the release target, insert the intent, append an audit event, and add a validation outbox row.
5. If the same idempotency key and record digest already exist, return the existing intent.
6. If an idempotency key or release target exists with different content, return `409`.

Queue send is not atomic with D1. The request attempts to enqueue after commit, and a cron-driven outbox drainer sends any remaining rows. Duplicate sends are expected.

### Validation

The worker claims a bounded lease, then:

1. Re-resolves the publisher DID and fetches the package profile from the current PDS.
2. Validates the profile lexicon and extension semantics.
3. Requires the package's signed profile repository to match the workload policy's repository.
4. Fetches and verifies all supplied artifact checksums.
5. Validates the package bundle and derives its canonical `declaredAccess`.
6. Requires bundle access to equal release-record access.
7. Fetches and verifies provenance when present.
8. Rejects absent provenance when `requireProvenance` is true.
9. Reads package releases directly from the PDS and selects the baseline.
10. Computes the structured access diff and escalation flag.
11. Derives `requiresApproval = confirmation === "always" || isEscalation`.
12. Stores the immutable snapshots and transitions to `awaiting_approval` or `publish_queued`.

An intent requiring approval remains stageable when no listed approver is enrolled. The console shows it as blocked and notifications explain that enrolment is required. It is never auto-approved.

### Approval

The approval page can be viewed only after atproto login proves a DID currently listed in the fetched package policy. It shows:

- Package, version, publisher DID, and signed source repository.
- GitHub repository, workflow, ref, commit SHA, run ID, run attempt, and environment.
- Artifact URL and checksum.
- Provenance URL, checksum, source, and builder.
- Previous release version and CID.
- Full declared-access diff, with escalation highlighted.
- Intent creation and expiry time.

`POST .../approval/options` re-fetches profile and baseline state before issuing a challenge. If either CID changed, the intent returns to `validating`. The challenge binds the approval digest, current profile CID, current baseline CID, approver DID, and action.

Approval verification:

1. Find the credential by response ID and require it to belong to the OAuth-proven approver DID.
2. Verify origin and RP ID.
3. Require user presence and user verification.
4. Consume the exact single-use challenge.
5. Verify signature and counter.
6. In one D1 batch, update the credential counter, append approval and audit rows, transition the intent, and create outbox rows.

Rejection uses a passkey assertion bound to action `reject`; it is not a weaker button click.

### Final verification and publication

Before PDS write, repeat all validation steps and require unchanged:

- Canonical release record digest.
- Workload policy version and enabled state.
- Package profile CID and policy digest.
- Baseline release CID.
- Artifact bytes and checksum.
- Provenance document and all four verification layers.

If the profile or baseline changed, invalidate the pending publication and return to validation. Human approval must be repeated if the recomputed intent still requires it.

Publication uses `com.atproto.repo.createRecord` or an `applyWrites` batch containing one create. The deterministic rkey is `<slug>:<version>`. It never updates the profile.

If the PDS call times out or returns an ambiguous transport error:

1. Fetch the deterministic AT URI from the PDS.
2. If it exists and canonical content equals the intended record, mark the intent published.
3. If absent, return to `publish_queued` with bounded exponential backoff.
4. If different content exists, mark `conflict` and alert the publisher.

Authentication or scope errors mark the delegation `reauthorization_required`; affected intents remain staged until expiry and the publisher is notified.

## Atproto OAuth

### Client metadata

Serve public metadata and JWKS from stable HTTPS URLs. The confidential client declares:

```json
{
	"application_type": "web",
	"grant_types": ["authorization_code", "refresh_token"],
	"response_types": ["code"],
	"dpop_bound_access_tokens": true,
	"token_endpoint_auth_method": "private_key_jwt",
	"token_endpoint_auth_signing_alg": "ES256"
}
```

The exact `client_id`, redirects, scope declaration, and `jwks_uri` are deployment-derived. Client assertion keys and per-session DPoP keys are distinct keypairs.

### OAuth purposes

| Purpose                 | Requested scope                             | Persistence                                             |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------- |
| Console login           | `atproto`                                   | Delete OAuth session after creating the service cookie. |
| Approver identity proof | `atproto`                                   | Delete immediately after matching the expected DID.     |
| Release delegation      | `atproto repo:<release-nsid>?action=create` | Store encrypted until revoked.                          |

Use separate logical atcute stores per purpose so sessions for the same DID cannot overwrite each other.

### OAuth client compatibility

`@atcute/oauth-node-client@2.0.1` is compatible with confidential-client custody in workerd. Its persisted `StoredSession` contains the token set, negotiated authentication method including the client assertion key ID, and per-session DPoP private key. Authorization state is a separate short-lived store. DPoP nonces are cached separately by origin; this cache may remain isolate-local because atcute's replayable token requests retry one recognized nonce challenge. Metadata caches may also remain isolate-local.

The package's in-memory request coalescing does not coordinate Worker isolates. Supply `requestLock` backed by the delegation's D1 lease, and hold that lease across session load, refresh, and persistence.

The package restores authorization state and sessions with their recorded client assertion key IDs. If a private key is absent, it throws a generic error and does not invalidate a session itself. Before callback, restore, or refresh, the service checks the recorded key ID against the configured private keyset and rejects unavailable-key state as requiring reauthorization.

### Session refresh

Refresh tokens are rotating and replay-sensitive. Before any restore that may refresh a writer session, atomically change `active` to `refreshing` and record a unique D1 lease owner. This durable marker poisons the persisted refresh-token generation before network I/O. Hold or renew the lease across session load, refresh, and persistence, and require the unexpired lease owner to match when atomically storing the rotated session and returning to `active`.

Never steal an expired lease from a `refreshing` row to retry its old session. A stale `refreshing` row, lost lease, or failed post-refresh persistence has an ambiguous single-use token outcome and transitions only to `reauthorization_required`. The package attempts to revoke a newly issued token after a store failure, but this is best effort and does not make the old token safe to retry.

Refresh proactively well before expiry and add jitter. A scheduled sweep refreshes idle sessions so a three-month refresh-token lifetime cannot lapse unnoticed.

Store the confidential client key ID used at initial authorization. Routine rotation publishes old and new public keys together, waits for JWKS cache propagation before ordering the new key first for new grants, and retains each old private key until its active sessions are reauthorized or revoked and every authorization transaction that may reference it has expired.

## GitHub Actions OIDC

```ts
interface WorkloadIssuer {
	verify(token: string, expectedAudience: string): Promise<VerifiedWorkload>;
}

interface VerifiedWorkload {
	issuer: string;
	subject: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	workflowRef: string;
	jobWorkflowRef?: string;
	ref: string;
	sha: string;
	runId: string;
	runAttempt: string;
	environment?: string;
	expiresAt: number;
}
```

The GitHub implementation verifies discovery metadata, remote JWKS signature, exact issuer, exact audience, `exp`, `nbf`, and reasonable `iat`. Authorization matches immutable repository and owner IDs, repository name, exact workflow identity, ref rules, and optional environment.

Never authorize from request-body repository fields, actor names, branch display names, or a GitHub organization name alone. Store normalized verified claims, not the raw JWT.

Workload cancellation requires a fresh OIDC token whose repository ID, workflow identity, run ID, and run attempt match the submitting workload evidence. The original bearer token and optional `jti` are not retained. A publisher may separately cancel any pre-publication intent through an authenticated console action; the audit log distinguishes workload and publisher cancellation.

## WebAuthn and Enrolment

Extend `@emdash-cms/auth/passkey` additively:

- `PasskeyConfig.userVerification?: "preferred" | "required"`.
- Verification checks `authenticatorData.userVerified` when required.
- Challenge data accepts an opaque typed context and returns it after atomic consumption.
- Existing CMS callers retain `preferred` as their default.

Service enrolment flow:

1. Approver opens an invitation or starts enrolment for their own DID.
2. Service performs atproto OAuth with scope `atproto`.
3. OAuth `sub` must equal the invitation target DID, when present.
4. Service issues WebAuthn registration with UV required and excludes existing credential IDs.
5. Verified credential is inserted with a user-provided name.
6. Enrolment is audited and publisher/approver notifications are queued.
7. The user returns to the intent page but no approval is created automatically.

An approver can add multiple credentials. Removing a credential requires a fresh atproto login and a passkey assertion from another active credential when one exists. If no credential remains, OAuth proof alone can start recovery, but the event is high-severity audited and notifies all publishers whose profiles currently list the DID.

Package authorization is always re-evaluated from the current signed profile. Retaining a credential after a DID is removed from one package is safe because the same DID may approve other packages.

## JSON API

All responses use:

```ts
type ApiResponse<T> =
	| { data: T; requestId: string }
	| { error: { code: string; message: string; details?: unknown }; requestId: string };
```

Errors have stable screaming-snake codes. Secrets and upstream raw errors never appear in `details`.

### CI endpoints

#### `POST /v1/release-intents`

Headers:

- `Authorization: Bearer <GitHub OIDC JWT>`
- `Idempotency-Key: <opaque run-generated key>`
- `Content-Type: application/json`

Body:

```json
{
	"publisherDid": "did:plc:...",
	"package": "gallery-plugin",
	"version": "1.2.3",
	"artifacts": {
		"package": {
			"url": "https://github.com/.../gallery-plugin.tgz",
			"checksum": "b...",
			"contentType": "application/gzip"
		}
	},
	"requires": { "env:emdash": ">=1.0.0" },
	"provenance": {
		"predicateType": "https://slsa.dev/provenance/v1",
		"url": "https://github.com/.../attestation.sigstore.json",
		"checksum": "b...",
		"sourceRepository": "https://github.com/example/gallery-plugin",
		"builderId": "https://github.com/example/gallery-plugin/.github/workflows/release.yml@refs/heads/main"
	}
}
```

The service derives `declaredAccess` from the fetched bundle. It may accept a caller-provided copy only to fail fast on disagreement; the service-derived value is authoritative for the record draft.

Response: `202` with intent ID, status URL, expiry, and approval URL when known.

#### `GET /v1/release-intents/:id`

CI authenticates with a fresh matching OIDC token. Browser console sessions may also read authorized intents. Returns status, safe evidence, approval requirement, failure code, and final AT URI/CID.

#### `POST /v1/release-intents/:id/cancel`

Requires either a fresh OIDC token matching the original repository, workflow, run ID, and run attempt, or the publisher's authenticated console session. Valid only before `publishing`.

### Publisher console endpoints

- `GET /v1/me`
- `GET /v1/delegations`
- `POST /v1/delegations/start`
- `DELETE /v1/delegations/:id`
- `GET /v1/packages`
- `GET /v1/packages/:slug/profile-policy`
- `GET|POST|PATCH|DELETE /v1/workload-policies`
- `GET /v1/release-intents`
- `GET /v1/release-intents/:id`
- `POST /v1/approver-invitations`
- `GET|POST|PATCH|DELETE /v1/notification-endpoints`
- `GET /v1/audit-events`

Mutations require the console CSRF token and same-origin request headers. A console session may manage only rows whose publisher DID matches its authenticated DID.

### Approver endpoints

- `GET /v1/enrolment-invitations/:token`
- `POST /v1/approver/oauth/start`
- `POST /v1/passkeys/registration/options`
- `POST /v1/passkeys/registration/verify`
- `GET /v1/passkeys`
- `PATCH|DELETE /v1/passkeys/:credentialId`
- `GET /v1/release-intents/:id/approval`
- `POST /v1/release-intents/:id/approval/options`
- `POST /v1/release-intents/:id/approve`
- `POST /v1/release-intents/:id/reject`

Approval details require an atproto-authenticated browser session whose DID is currently listed by the package profile. The untrusted approval URL alone exposes only package name, status, and a login prompt.

## Web Console

Build a React SPA served by the Worker static-assets binding. Use Kumo components and Lingui from the beginning. All layouts use logical RTL-safe classes.

Publisher pages:

- Overview: delegation health, packages, held intents, failed deliveries.
- Delegation: exact scope, PDS, key/session health, revoke and reauthorize actions.
- Packages: current signed policy, enrolled/listed approver matrix, workload policies.
- Workload policy editor: typed GitHub repository, workflow, ref, and environment controls.
- Intents: searchable lifecycle history and exact verification results.
- Notifications: verified email routes, webhooks, event selection, test delivery, secret rotation.
- Audit: actor, action, target, outcome, and timestamp with filters and export.

Approver pages:

- Enrolment invitation and atproto identity proof.
- Passkey list with names, creation, last use, and individual revocation.
- Approval detail with workload, provenance, checksums, and access diff.
- Success, rejection, cancellation, and expiry states.

The console displays signed profile policy read-only. To change `requireProvenance`, `confirmation`, or `approvers`, it generates the corresponding `emdash-plugin policy` command and refreshes until the new profile CID appears. This preserves the RFC's profile-scope separation. A future browser-only direct-to-PDS editor may be added only if profile tokens never reach the service Worker.

## Notifications

Events:

- `intent.awaiting_approval`
- `intent.approved`
- `intent.rejected`
- `intent.cancelled`
- `intent.expired`
- `intent.published`
- `intent.failed`
- `delegation.reauthorization_required`
- `approver.enrolled`
- `approver.credential_added`
- `approver.credential_removed`
- `approver.recovery`
- `delivery.disabled`

Email contains the package, version, intent ID, and service-origin URL. It does not include full workload claims, access details, or secrets. Those require authenticated console access.

Webhook delivery:

- Stable event ID and schema version.
- `X-EmDash-Event`, `X-EmDash-Delivery`, `X-EmDash-Timestamp`, and HMAC-SHA256 signature headers.
- Signature input is `<timestamp>.<raw-body>`.
- At-least-once semantics; receivers deduplicate by delivery ID.
- Manual redirect handling and SSRF checks on every attempt.
- Exponential retries with jitter, then DLQ and endpoint disable threshold.
- Secret shown once and rotatable with an overlap window.

Use interfaces for `Mailer` and `WebhookDispatcher`. The hosted adapter uses Cloudflare Email Service and Workers fetch; a Workers self-host may select another HTTP mail adapter. A future Node port can add SMTP without changing the webhook contract.

## CLI and GitHub Action

Add a shared client under `packages/registry-client/src/delegated`.

Commands:

```text
emdash-plugin delegate --service <url>
emdash-plugin policy set --require-provenance --confirmation always --approver <did>
emdash-plugin enrol --service <url> [--invite <token>]
emdash-plugin approve <intent-id> --service <url>
emdash-plugin release submit --service <url> --url <artifact> --provenance <bundle>
emdash-plugin release status <intent-id> --service <url> [--wait]
emdash-plugin release cancel <intent-id> --service <url>
```

`delegate` opens the service OAuth flow and waits for completion. `enrol` and `approve` open the service-hosted WebAuthn page because terminal programs cannot directly perform a platform passkey ceremony.

Provide an official GitHub Action wrapping OIDC acquisition and intent submission. It outputs:

- `intent-id`
- `status`
- `approval-url` when held
- `release-uri` when published

The action waits by default until `published`, `awaiting_approval`, or terminal failure. It never accepts an atproto secret input.

## Installer Changes

`packages/core` must enforce the signed policy independently of the service and aggregator.

Install flow additions:

1. Fetch the current release and package profile directly from the publisher PDS with record proof as already required by RFC 0001.
2. Validate profile and release extensions.
3. Verify artifact checksum and manifest access as today, using the shared package.
4. If provenance is present, run all provenance checks.
5. If `requireProvenance` was in force for the release and provenance is absent or failed, block installation.
6. If provenance is optional and absent, continue with an explicit "not attested" status.
7. If provenance is present but failed or unverifiable, block. Never downgrade it to absent.
8. Surface source repository, builder identity, workflow, and verified/unverified state without presenting provenance as malware safety.

Historical policy-at-publication cannot be reconstructed from only the current profile after a legitimate policy change. Until the protocol carries a policy snapshot/receipt, direct installers use the current signed policy as a conservative floor. The aggregator tracks event history for accurate discovery-time status. This limitation must be explicit in UI and RFC text.

## Aggregator Changes

The aggregator needs event-history work before it can implement the RFC's "policy in force at publication time" rule.

### Ingest ordering

**Gate 0B decision (W0.6): `subscribeRepos` firehose `#commit` events are the selected source. Gate 0B is complete.**

The `com.atproto.sync.subscribeRepos` firehose `#commit` event is the selected viable standardized ATProto source that provides event-specific record values with verifiable ordering and cryptographic proof material. Each `#commit` event carries: `seq` (relay-scoped monotonic ordering key, not comparable across relay and direct-PDS sources), `rev` (TID repo revision, per-repo logical clock), `since` (the `rev` of the preceding commit for this repo, enabling per-repo chain continuity checks), `commit` (CID of the signed commit object), `blocks` (CAR slice containing the signed commit and MST diff nodes), `ops` (per-record operations with new CID and, for updates and deletes, `prev` CID of the prior record version), and `prevData` (previous MST root CID, required for MST inversion). The signed commit in `blocks` is verifiable against the DID's signing key that was valid at the time of the commit. MST inversion against `prevData` confirms the ops list is complete and unmanipulated, but requires the aggregator to have maintained inductive firehose state from the prior commit; it is not independently verifiable from a single event in isolation.

**Sources evaluated and rejected:**

- **Jetstream (current production deployment and the experimental archival rewrite under development):** Both strip CAR blocks and MST proof material, providing JSON-decoded record values without commit signatures or MST proofs. The current production Jetstream does not provide `prev` CID for updates and has no historical backfill API for intermediate record states. The experimental archival rewrite stores full-network segments on disk and is not yet deployed to production; its on-disk format is still changing and it does not expose a stable API for retrieving intermediate record states with proof material. Neither is sufficient for a verifiable trust model.
- **`getRepo` (CAR export):** Returns current repo state only. The `since` parameter returns a diff from a given rev, but only for what the PDS still holds; intermediate values between two revisions are not recoverable if the PDS has since advanced. Cannot reconstruct intermediate profile states after the fact.
- **`getRecord`:** Returns a CAR proof for the current record only. No historical versions.
- **PDS repo history:** The `prev` field in v3 commit objects is virtually always `null`. No standard API enumerates historical commits from a PDS.
- **`did:plc` audit log:** Provides a complete, hash-linked, verifiable chain of DID document operations (PDS endpoint, signing keys, handles). Does not contain profile record content. Useful only for identity resolution, not profile policy history. `#identity` firehose events signal that identity may have changed and prompt re-resolution; they do not carry key material themselves.

**Trust model and constraints for W10.1:**

The aggregator must subscribe to `subscribeRepos` from the relay (or directly from each publisher's PDS) and process `#commit` events in real time. For each profile-collection commit, extract the record value from the CAR blocks at the CID indicated by the op, attempt commit signature verification against the DID's signing key that was valid at the commit's `rev`, and verify MST inversion against `prevData` using inductive state from the prior processed commit. Persist the event-specific record value, CID, `rev`, `seq`, the signed commit block, and the MST proof slice needed to bind the record transition (the signed commit block, the referenced record block, and the MST diff nodes required for inversion). Retaining only the signed commit block is insufficient for later independent verification; the full proof slice must be retained if post-hoc re-verification is required, or the verification scope must be explicitly limited to ingest time.

Trust assumptions:

- `seq` is relay-scoped and monotonically increasing within a single relay connection. It must not be compared across relay and direct-PDS sources, or across different relay instances. Per-repo continuity is tracked via `#commit.since` (which must equal the last processed `rev` for that DID) and `rev` (which must increase monotonically per DID). Gaps in `since`/`rev` continuity, not gaps in `seq`, are the signal for per-repo desynchronization.
- Commit signature verification requires the DID's signing key that was valid at the time of the commit. `#identity` events signal that the DID document may have changed and require the aggregator to re-resolve the DID document; they do not carry key material. The aggregator must maintain a per-DID key history sufficient to verify commits against the key active at each `rev`. If historical key material is unavailable (the old key has been removed from the DID document and was not retained by the aggregator), the commit signature cannot be verified retroactively. This is an explicit limitation of the atproto signing model; such events are marked "signature unverifiable at ingest" but their record value is retained if the MST inversion check passed at ingest time.
- `prevData` and `op.prev` validation requires inductive firehose state: the aggregator must have successfully processed the prior commit for the same DID and retained its MST root. A `tooBig` event (deprecated but may appear from older producers) or a `#sync` event breaks the inductive chain; both must be treated as a gap requiring `getRepo` re-sync, not as proof of intermediate history.
- The relay backfill window is hours to days, not permanent. Profile events that occurred before the aggregator began consuming are not recoverable from the relay. For publishers who registered before the aggregator's subscription start, the aggregator can only recover the current profile state via `getRepo` and must mark all prior policy events as unrecoverable.

**Retention and backfill constraints:**

- The aggregator must start consuming the firehose before any publisher registers. For publishers already registered at aggregator launch, bootstrap via `getRepo` to capture current state; mark historical policy events before the bootstrap rev as unrecoverable.
- The relay backfill window (hours to days) is the only replay mechanism. The aggregator must maintain a persistent cursor and reconnect within the window after any outage. Outages exceeding the backfill window require `getRepo` re-sync and mark the gap period as unrecoverable.
- `listReposByCollection` on the relay enumerates all DIDs with records in a given collection, enabling targeted backfill of known publishers.

**Fork, rebase, and tombstone handling:**

- The `rebase` field in `#commit` is deprecated and unused in v3 repos. Treat it as always false.
- A `#sync` event resets the repo to a new state without providing intermediate history. On receipt of a `#sync`, mark the repo as desynchronized, fetch the full repo via `getRepo`, and mark any gap in policy events as unrecoverable.
- A `tooBig` event (deprecated; producers should always set it to `false`) breaks the inductive chain in the same way as `#sync`. Treat it as a gap requiring `getRepo` re-sync.
- Account deletion (`#account` with `active=false, status=deleted`) makes the repo unavailable. Mark all policy events after the last known rev as unrecoverable. Historical events already persisted remain valid.
- Account deactivation (`status=deactivated`) is temporary; resume on reactivation.

**Explicit W10.1 constraints:**

- W10.1 must subscribe to `subscribeRepos` from the relay and process `#commit` events in real time.
- For each profile-collection op, extract the record value from the CAR blocks, attempt commit signature verification against the DID's signing key valid at the commit's `rev`, and verify MST inversion using inductive state from the prior processed commit for that DID.
- Persist: `seq`, `rev`, `since`, `commit` CID, record CID, record value (CBOR bytes), the signed commit block, and the MST proof slice (signed commit block, referenced record block, and MST diff nodes needed for inversion). Retaining only the signed commit block is insufficient for later independent re-verification; the full proof slice is required for that guarantee, or the verification scope must be explicitly documented as ingest-time only.
- Track per-DID last-seen `rev`, `prevData`, and inductive MST state. Use `#commit.since` to detect per-repo chain breaks; do not rely on `seq` gaps for per-repo continuity.
- On chain break, `#sync`, `tooBig`, or `getRepo` re-sync, mark the gap as unrecoverable.
- On `#identity`, re-resolve the DID document and update the cached key history; do not assume the event carries key material.
- For publishers bootstrapped from `getRepo` at aggregator launch, mark all policy events before the bootstrap rev as unrecoverable.
- Unrecoverable gaps must be surfaced in the policy history view and must not be silently treated as "no policy change occurred."
- Commit signature verification against a key no longer in the DID document is not possible retroactively; such events are marked "signature unverifiable" but their record value is retained if MST inversion passed at ingest time.
- Do not claim downgrade cooldown accuracy for any period marked unrecoverable.

### Schema

Add:

- Raw profile extension and current policy digest on `packages`.
- `package_policy_events` with DID, slug, event ordering key, profile CID, policy, repository, and transition classification.
- Provenance reference, policy event ID, policy status, reasons, and verification time on `releases`.
- A provenance verification queue/outbox.
- Downgrade notification state and cooldown expiry.

Release policy status is `pending`, `valid`, `invalid`, or `unverifiable`. Default search, latest-release selection, and update discovery exclude `pending`, `invalid`, and `unverifiable` releases when policy requires provenance. Explicit audit endpoints may return them with reasons.

Policy weakening transitions include `requireProvenance: true -> false`, `confirmation: always -> escalation-only`, and removal of approvers. Only `requireProvenance` affects install validity; the other transitions are audit signals because confirmation is not installer-verifiable.

Expensive provenance work runs asynchronously. Structural ingest writes `pending`, queues verification, and updates status with CAS. Any exposed pending/invalid release carries explicit status; it is never silently treated as valid.

## Encryption and Key Management

Use AES-256-GCM with a versioned master key supplied by a Worker secret or Secrets Store. Derive purpose-specific data-encryption keys with HKDF. Associated data includes table name, row primary key, publisher DID, and key version.

Encrypt:

- atcute OAuth session blobs and DPoP private keys.
- Confidential client private keys if not directly represented as deployment secrets.
- Email addresses.
- Webhook URLs when they contain private paths or tokens.
- Webhook secrets.

Never encrypt fields that need indexed equality; store a separate keyed hash when lookup is required. Key rotation rewrites rows in bounded queue jobs. Old keys remain available until migration completes and verification reports zero old-version rows.

## Abuse and Platform Security

- Rate-limit intent submission by workload policy, publisher, package, and source network.
- Cap active intents per package and publisher.
- Reserve storage before remote fetches and expire abandoned intents.
- Reject URLs before enqueueing when syntax is unsafe; repeat DNS/IP checks during fetch.
- Apply strict CSP, frame ancestors, referrer policy, secure cookies, and origin checks to console and approval pages.
- Use random opaque public intent IDs; do not expose D1 row IDs or sequential identifiers.
- Redact all bearer tokens and OAuth materials from logs and Sentry.
- Treat provenance parser and tar parser input as hostile and fuzz both.
- Keep approval and enrolment pages on one configured RP origin; preview deployments use separate RP IDs and databases.
- Require explicit operator configuration for trusted origins, client ID, audience, email sender, and public base URL. Fail closed when absent.

## Background Work

Queues:

- `release-validation`: validation and publication jobs.
- `release-notifications`: email and webhook jobs.
- A DLQ for each queue.

Cron tasks:

- Every minute: drain unsent outbox rows and expire staged intents.
- Every 5 minutes: reclaim expired worker leases and reconcile `publishing` intents.
- Daily: refresh delegations approaching refresh-token expiry, re-resolve stale DIDs, prune consumed OAuth state and challenges, and verify notification endpoint health.

Every consumer is idempotent and begins with a state/version CAS. DLQ consumers persist a forensics row or audit event before acknowledging.

## Observability

Structured logs and metrics include:

- Intent counts and latency by lifecycle state.
- Validation failure code and layer, without private payloads.
- OIDC failures by reason.
- OAuth refresh success, contention, and reauthorization count.
- PDS write latency, ambiguous outcomes, and reconciliation result.
- Approval wait duration and expiry rate.
- Queue age, retries, and DLQ count.
- Email/webhook delivery success and endpoint disable count.
- D1 query and write latency.
- Active leases and lease-steal count.

Security alerts:

- Delegation scope mismatch.
- OAuth client key removal or refresh replay error.
- Re-enrolment or recovery.
- Different record at a reserved release rkey.
- Repeated provenance or artifact mutation between stage and approval.
- Repeated OIDC replay or policy mismatch.
- Webhook SSRF attempt.

## Testing

### Protocol and shared package

- Lexicon valid/invalid fixtures and generated-type tests.
- Checksum vectors for supported and unsupported algorithms.
- URL redirect, DNS rebinding, private IPv4/IPv6, metadata endpoint, timeout, and oversize tests.
- Tar traversal, duplicate normalized path, duplicate manifest, links, devices, gzip bomb, and cap tests.
- Every declared-access widening and narrowing rule.
- Valid Sigstore bundle, bad signature, wrong subject, substituted bundle, wrong repository, wrong builder, unknown predicate, and expired trust material.

### Service unit and workerd integration

- Real D1 migrations with `@cloudflare/vitest-pool-workers`.
- OIDC signature, issuer, audience, time, immutable claim, policy, and replay failures.
- Duplicate idempotency and version races.
- First release with non-empty access requires approval.
- `confirmation: always` requires approval for unchanged access.
- Listed but unenrolled approver cannot approve.
- Removed approver cannot approve with a retained credential.
- Required-UV rejects a user-present-only assertion.
- Challenge replay and cross-intent/action replay fail.
- Profile, baseline, artifact, provenance, or workload-policy mutation invalidates approval.
- Concurrent OAuth refresh obtains one lease and preserves the rotated session.
- Ambiguous PDS write reconciles exact match, absence, and conflicting content.
- Queue redelivery, outbox recovery, lease expiry, stage expiry, rejection, and cancellation.
- Email/webhook deduplication, signature, redirect, retry, and disable behavior.
- Encryption round trip and key rotation.

### Browser E2E

Use the existing virtual authenticator fixture pattern from `e2e/fixtures/virtual-authenticator.ts`.

- Publisher signs in and creates a GitHub policy.
- Publisher establishes the create-only delegation.
- Approver accepts invitation through atproto OAuth and registers two passkeys.
- Enrolment does not approve an existing intent.
- Approver reviews and approves an escalating intent.
- A second credential can approve after the first is revoked.
- Arabic locale and RTL layout for every new console flow.

### End-to-end protocol

Against a test PDS and fake GitHub issuer:

1. Publish a signed profile with strict policy.
2. Submit an attested artifact from CI.
3. Approve with a virtual passkey.
4. Create the release record through the scoped session.
5. Ingest it in the aggregator.
6. Install it from a clean EmDash site with independent provenance verification.

Run a second suite against real GitHub OIDC, a Bluesky-hosted PDS, and at least one supported alternative PDS in a controlled repository before production launch. For each PDS, verify successful release creation and rejection of release update/delete, profile create/update, and unrelated collection writes, plus revocation and client-key removal behavior.

## Delivery Plan

### Phase 0: RFC clarification and external validation

- Complete: record implementation acceptance criteria for the profile extension, repository anchor, release provenance, and escalation contracts already decided by RFC #1870.
- Deferred to conformance and production smoke: validate create-only permission support on every supported deployed PDS without broad fallback.
- Complete: confirmed `@atcute/oauth-node-client@2.0.1` confidential-client persistence, DPoP nonce retry, D1 lock requirements, and client-key rotation behavior in workerd.
- Complete: inspect a real GitHub provenance bundle and land the Workers-compatible Sigstore verifier plus exact field mapping.
- Complete (Gate 0B): `subscribeRepos` firehose `#commit` events selected as the aggregator history source. Trust model, retention constraints, fork/rebase/tombstone handling, and explicit `W10.1` constraints documented in the Aggregator Changes section.
- Complete: use `emdash-plugin` as the v1 public command.

OAuth custody feasibility is complete. Gate 0B is complete: `subscribeRepos` firehose `#commit` events are the selected source; trust model, constraints, and W10.1 requirements are documented in the Aggregator Changes section.

### Phase 1: Protocol and verification foundation

- Complete: land profile and release lexicon additions.
- In progress: complete `@emdash-cms/registry-verification` with direct-PDS record/policy verification.
- Complete: land declared-access canonical diff.
- Extend passkey primitives with required UV and bound challenge context.
- Extract create-only release record construction into `registry-client`.
- Switch existing installer integrity checks to shared verification where behavior is equivalent.

Exit criterion: records can represent the RFC, and service/installer use identical verification fixtures.

### Phase 2: Secure automated vertical slice

- Scaffold `apps/release-service` with D1, OAuth, GitHub OIDC, intent state machine, queues, and publication reconciliation.
- Implement delegation and minimal publisher console.
- Implement approver OAuth, multiple passkeys, approval pages, and audit.
- Implement CLI API client and official GitHub Action.
- Implement install-time provenance and policy enforcement.
- Add minimum aggregator policy status and default filtering. Until historical ordering lands, apply the current signed profile as a conservative floor and mark the result accordingly.

Exit criterion: GitHub Actions can publish an attested release without a stored atproto credential, including an escalation requiring passkey approval, and a clean site independently verifies and installs it.

### Phase 3: Hosted product completeness

- Complete the publisher console and localization.
- Add email, webhook management, retries, and delivery UI.
- Add credential recovery, delegation health, key rotation tooling, and audit export.
- Add operator abuse controls and production observability.
- Publish Workers/D1 self-hosting docs and deployment templates.

Exit criterion: the default hosted instance and a fresh Workers/D1 self-host can complete all service lifecycle operations without database/operator hand edits. Public production launch remains blocked on Phase 4's accurate aggregator history.

### Phase 4: Aggregator policy enforcement

- Preserve event-specific policy history.
- Add asynchronous provenance verification.
- Add policy status to read views and default filtering.
- Add downgrade cooldown and security-contact notification.

Exit criterion: discovery accurately applies policy in force at publication time and survives out-of-order/replayed ingest.

Phase 4 is a production launch gate for the default public service and registry, not optional post-launch hardening.

### Phase 5: Hardening and expansion

- External security review and parser fuzzing.
- Load and failure-injection tests.
- Additional OIDC issuers through the existing interface.
- Evaluate a per-publisher DO coordinator using measured refresh/publish contention.
- Consider signed approval receipts and quorum in a new RFC.

## Acceptance Criteria

- No atproto account credential exists in CI configuration or logs.
- The retained grant is demonstrably create-only for the active release NSID.
- The service cannot write profile records with its retained grant.
- Every escalation and every `confirmation: always` release requires a current listed approver's UV passkey assertion.
- Changing any approval-bound input invalidates the approval.
- A PDS timeout cannot create a duplicate or cause a successful release to be reported permanently failed.
- An installer rejects missing required provenance and every failed provenance layer without trusting service or aggregator status.
- The hosted service supports multiple passkeys, email, webhooks, full publisher audit, and self-service delegation.
- The implementation runs under Workers with real D1/Queue tests and has no DO correctness dependency.
- A self-host can deploy the same Worker with its own D1, Queues, cron triggers, Email Service or mail adapter, and webhook configuration without changing protocol or API semantics.

## Known Residual Risks

- A compromised release service can use active grants to publish unwanted releases that still satisfy signed profile and provenance constraints.
- Compromise of the service encryption key exposes all retained publisher sessions for that deployment.
- Revoking a confidential client key does not invalidate already-issued access tokens immediately.
- Hosted CI and Sigstore are part of provenance trust; a compromised authorized workflow can produce genuinely attested malicious output.
- Confirmation remains unverifiable at install time until the protocol carries signed approval receipts.
- Current-profile enforcement by a direct installer cannot perfectly reconstruct policy at historical publication time.
- Unknown declared-access constraints must be treated conservatively, which can require approval for a change that is actually narrowing.
- D1 and PDS cannot commit atomically; deterministic keys and reconciliation reduce, but do not remove, operational complexity.

## Implementation Blockers to Resolve First

All Gate 0 blockers are resolved. Gate 0A (OAuth custody) and Gate 0B (historical ingest source) are complete. Deployed-PDS compatibility (`W0.3`) is deferred to `W12.7` conformance and production smoke.
