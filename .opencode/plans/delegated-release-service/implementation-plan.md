# Delegated Release Service Implementation Plan

Companion: [Implementation spec](./spec.md)

Status: implementation in progress; deployed-PDS validation is deferred to `W12.7`; Gate 0B complete

This plan turns the delegated release service spec into independently deliverable workstreams. It defines ownership boundaries, dependencies, integration gates, and completion criteria. It intentionally contains no time estimates.

## Stage Deliverables

| Stage   | Deliverable                                                                        | Repository change allowed                                         |
| ------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Gate 0A | Complete: confidential OAuth custody feasibility                                   | Spec and plan updates only                                        |
| Gate 0B | Complete: `subscribeRepos` `#commit` events selected; W10.1 constraints documented | Spec and plan updates only                                        |
| Gate 1  | Experimental lexicons, generated types, and one shared verification contract       | Production contract code and tests                                |
| Gate 2  | Secure delegated release service vertical slice                                    | Service, client, and installer code and tests                     |
| Gate 3  | Independent install and minimum discovery enforcement                              | Installer and aggregator code and tests                           |
| Gate 4  | Hosted beta product and operational readiness                                      | Console, notifications, tooling, operations, and conformance code |
| Gate 5  | Accurate historical policy enforcement and production launch evidence              | Aggregator history implementation and production verification     |

Gates 0A and 0B are deliberately not implementation stages. RFC #1870 is the product and protocol decision; these gates record only implementation clarifications and external validation. Gate 0A is complete. Deployed-PDS compatibility remains required by conformance and production smoke but does not block implementation. Gate 0B blocks historical aggregator enforcement and production launch, but does not block shared verification, installer work, or the service. Do not reopen RFC decisions unless the text is ambiguous, contradicts an existing constraint, or an external result makes it impossible. Do not add repository test harnesses, prototype services, package dependencies, root scripts, or CI wiring for these gates. Commit concise conclusions directly to the integration branch.

## Implementation Baseline

The integration branch includes these completed merge units:

| Work items                 | Evidence | Result                                                                 |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| `W0.1`, `W0.2`, `W0.7`     | #1915    | RFC acceptance criteria and `emdash-plugin` command decision recorded. |
| `W1.1` through `W1.3`      | #1918    | Experimental profile and release contracts and generated types landed. |
| `W1.4`                     | #1920    | Existing profile writers preserve extensions.                          |
| `W1.5`                     | #1925    | Local profile-policy command landed.                                   |
| `W2.1`, `W2.2` foundations | #1929    | Shared verification package, checksums, and safe fetching landed.      |
| `W2.3`                     | #1932    | Canonical plugin bundle validation landed.                             |
| `W2.4`                     | #1937    | Declared-access canonicalization and escalation landed.                |
| `W0.5`                     | #1943    | Public Sigstore verification feasibility in workerd proved.            |
| `W2.5`                     | #1951    | Production public Sigstore provenance verification landed.             |
| `W0.4`                     | Direct   | Confidential OAuth custody and refresh are compatible with workerd.    |

`W0.6` is complete: `subscribeRepos` `#commit` events selected; see Gate 0B and the Aggregator Changes section of the spec for W10.1 constraints. Deployed-PDS compatibility from `W0.3` moves to conformance and production smoke. The next shared-verification merge unit is combined `W2.6` and `W2.7`; `W1.6` and `W1.7` land together to establish the exact supported scope contract.

## Outcomes

The implementation is complete when:

1. A publisher can establish an atproto OAuth grant restricted to create-only release records.
2. GitHub Actions can submit an attested release without storing an atproto credential.
3. The service validates the artifact, manifest access, provenance, source, workflow, and signed profile policy.
4. Releases requiring confirmation are held until a currently authorized approver uses a previously enrolled, UV-capable passkey.
5. The service publishes exactly one immutable release record and reconciles ambiguous PDS responses.
6. An EmDash installer independently repeats integrity, provenance, and policy verification.
7. The aggregator records policy history, verifies provenance, and excludes policy-violating releases from default discovery.
8. Publishers can manage delegation, workflow policies, approvers, notification endpoints, and audit history through the web console.
9. The hosted service and a fresh Workers/D1 self-host pass the same conformance suite.

## Execution Rules

- Protocol and security semantics live in shared packages, not independently in the service, installer, and aggregator.
- Every workstream lands tests with its implementation. Tests are not a cleanup phase.
- New public record fields remain optional until the stable namespace migration.
- No component accepts `transition:generic` as a fallback for delegated publishing.
- No implementation path may overwrite a release record.
- Every asynchronous consumer is idempotent before it is connected to a real queue.
- User-facing console work uses Kumo, Lingui, and RTL-safe layout from its first PR.
- Public beta may begin after Gate 4. Production launch remains blocked on accurate aggregator policy history in Gate 5.
- Work behind an incomplete integration must be unreachable by default, not merely undocumented.

## Dependency Model

### Workstream IDs

| ID    | Workstream                            | Primary output                                              |
| ----- | ------------------------------------- | ----------------------------------------------------------- |
| `W0`  | Clarification and external validation | RFC-derived acceptance criteria and platform assumptions    |
| `W1`  | Protocol and lexicons                 | Profile policy and release provenance records               |
| `W2`  | Shared verification                   | One verification implementation for all consumers           |
| `W3`  | OAuth, crypto, and passkeys           | Secure identity, grant custody, and approval primitives     |
| `W4`  | Workload identity                     | GitHub OIDC verification and typed workflow policies        |
| `W5`  | Service persistence and orchestration | D1 state machine, queues, publication, reconciliation       |
| `W6`  | Publisher and approver console        | Full management and approval UI                             |
| `W7`  | Notifications                         | Email, signed webhooks, outbox delivery                     |
| `W8`  | CLI and GitHub Action                 | Author and CI clients                                       |
| `W9`  | Installer enforcement                 | Independent install-time verification                       |
| `W10` | Aggregator enforcement                | Historical policy and discovery filtering                   |
| `W11` | Operations and self-hosting           | Production config, observability, abuse controls, runbooks  |
| `W12` | Conformance and security              | Cross-component, browser, adversarial, and production tests |

### High-Level Graph

```mermaid
flowchart TD
    W0A[W0A Service feasibility]
    W0B[W0B History feasibility]
    W1[W1 Protocol and lexicons]
    W2[W2 Shared verification]
    W3[W3 OAuth, crypto, passkeys]
    W4[W4 GitHub workload identity]
    W5[W5 Service orchestration]
    W6[W6 Web console]
    W7[W7 Notifications]
    W8[W8 CLI and GitHub Action]
    W9[W9 Installer enforcement]
    W10M[W10 Minimum aggregator enforcement]
    W10H[W10 Historical aggregator enforcement]
    W11[W11 Operations and self-hosting]
    W12[W12 Conformance and security]

    W0A --> W1
    W0A --> W3
    W0B --> W10H
    W1 --> W2
    W1 --> W5
    W1 --> W8
    W1 --> W9
    W1 --> W10M
    W2 --> W5
    W2 --> W9
    W2 --> W10M
    W3 --> W5
    W3 --> W6
    W4 --> W5
    W4 --> W6
    W5 --> W6
    W5 --> W7
    W5 --> W8
    W5 --> W11
    W7 --> W6
    W8 --> W12
    W9 --> W12
    W10M --> W10H
    W10M --> W12
    W10H --> W12
    W11 --> W12
```

### Critical Path

```text
Service path: W1 -> W2 -> W5 -> W9 -> W12
Launch-history path: W0B -> W10 -> W12
```

Historical aggregator work depends on Gate 0B. Service, installer, and most API/UI work proceed independently once their code dependencies are satisfied.

## Integration Gates

### Gate 0A: OAuth Custody Feasibility

Complete:

- Confidential OAuth sessions can be restored and refreshed safely in workerd.
- Persistence, refresh locking, nonce handling, and client-key rotation constraints are recorded in `W0.4`.

Gate owner: `W0`.

Deployed-PDS create-only compatibility is validated by the conformance suite and production smoke before support is claimed. Failure removes that PDS from the support matrix or changes the RFC; it never adds a broad-scope fallback.

### Gate 0B: Historical Ingest Feasibility

Complete.

- Source selected: `subscribeRepos` firehose `#commit` events.
- The source provides event-specific record values, CIDs, revisions (`rev`), ordering keys (`seq`), and verifiable commit proof material (signed commit block in CAR, MST inversion via `prevData`).
- Trust model, retention constraints, backfill limits, fork/rebase/tombstone handling, and explicit W10.1 constraints are documented in the Aggregator Changes section of the spec.

Gate owner: `W0`.

`W10.1` through `W10.3` and `W10.5` through `W10.7` may proceed. Minimum current-policy filtering in `W10.4` was already unblocked.

### Gate 1: Protocol and Verification Foundation

- New profile and release extension fixtures round-trip through generated lexicon types.
- Existing profile writers preserve unknown and policy extensions.
- Shared checksum, fetch, bundle, access-diff, and provenance tests pass in Node and workerd.
- The active release collection and exact create-only scope are exposed by one typed contract.
- One narrow registry-client helper can create, but cannot update or delete, a delegated release.
- Direct PDS reads and record/policy verification produce one structured report and stable error codes for every consumer.
- Installer, service, and aggregator can consume the same fixture corpus and report contract.

Gate owners: `W1`, `W2`.

### Gate 2: Secure Service Core

- A publisher can establish and revoke an exact create-only delegation.
- GitHub OIDC submission creates one D1 intent and survives Queue redelivery.
- Automatic and passkey-approved paths publish through the same final verification function.
- Ambiguous PDS writes reconcile exact match, confirmed absence, and conflict.
- No profile write or release overwrite operation exists in the retained-session path.

Gate owners: `W3`, `W4`, `W5`.

### Gate 3: Independent Consumer Enforcement

- A clean EmDash site independently blocks absent-required, failed, and unverifiable provenance.
- The installer does not trust release-service or aggregator verification status.
- The aggregator marks unsupported or unverified policy state and excludes it from default discovery.

Gate owners: `W9`, minimum `W10`.

### Gate 4: Hosted Beta Readiness

- Full console, multiple passkeys, email, webhooks, audit, recovery, and delegation health work without operator database edits.
- Official CLI and GitHub Action pass the service conformance suite.
- Abuse limits, encryption rotation, alerts, backup/export, and self-hosting docs are complete.
- External security review has no unresolved critical or high findings.

Gate owners: `W6`, `W7`, `W8`, `W11`, `W12`.

### Gate 5: Production Registry Launch

- Aggregator policy-at-publication history is accurate under rapid profile changes, event reordering, queue delay, and replay.
- Downgrade cooldown and notification behavior pass conformance tests.
- Default discovery cannot recommend a release whose required provenance is pending, invalid, or unverifiable.
- End-to-end production smoke succeeds from real GitHub OIDC through PDS, aggregator, and clean-site installation.

Gate owners: `W10`, `W12`.

## Workstream W0: Decisions and Feasibility

This workstream closes the implementation blockers in the spec. Its outputs are RFC-derived acceptance criteria and concise research conclusions. It does not land product code, test fixtures, package dependencies, or internal prototypes.

### `W0.1` Record the profile contract acceptance criteria

Extract from RFC #1870:

- Exact profile extension NSID.
- Exact location and canonical form of the signed repository URL.
- Release-policy object shape and defaults.
- Provenance reference shape.
- Stable treatment of unknown provenance predicates.
- Experimental-to-stable NSID migration consequences for OAuth grants.

Output: an implementation acceptance table and matching JSON examples. Do not reopen the RFC decision unless its text is contradictory or ambiguous.

Dependencies: none.

### `W0.2` Record escalation acceptance criteria

Extract from RFC #1870:

- Highest-semver current release as the baseline.
- First release uses empty access.
- Out-of-order publication behavior.
- `allowedHosts` containment rules.
- Unknown constraint changes are conservatively escalating.
- Which baseline changes invalidate an approval.

Output: an implementation acceptance table consumed directly by `W2.4` tests. Do not reopen the RFC decision unless its text is contradictory or ambiguous.

Dependencies: none.

### `W0.3` Validate deployed-PDS create-only support

Validate externally, against the candidate PDS implementations:

- `atproto repo:<experimental-release-nsid>?action=create` authorization.
- Successful release create.
- Rejected update, delete, profile create/update, and unrelated collection writes.
- Revocation endpoint behavior.
- Key-removal behavior before and after access-token expiry.

Targets: Bluesky-hosted PDS and at least one alternative implementation intended for support.

Output: a supported-PDS compatibility matrix and any required RFC/spec correction. This validation now runs with `W12.7` conformance and production smoke rather than blocking implementation. Keep disposable clients and accounts outside this repository.

Dependencies: `W0.1` draft NSID.

### `W0.4` Prove confidential OAuth custody in workerd

Research the real `@atcute/oauth-node-client` behavior needed by the future service:

- Private-key JWT and published JWKS.
- Separate client assertion and DPoP keys.
- D1-backed session restore.
- Nonce retry.
- Concurrent refresh attempts under a D1 lease.
- Rotating refresh tokens and client assertion keys.

Output: exact persisted session requirements, lock expectations, key-rotation constraints, and any incompatible upstream behavior. Commit only a concise spec/plan update when the result changes the design.

Result: complete against `@atcute/oauth-node-client@2.0.1`. Private-key JWT, public JWKS derivation, separate assertion and DPoP keys, and nonce retry run in workerd. Persist `StoredSession` (`tokenSet`, `authMethod`, and `dpopKey`) and short-lived authorization state in D1. DPoP nonce and metadata caches may remain isolate-local; atcute's replayable token requests retry one recognized nonce challenge after a cache miss.

Supply a D1-lease-backed `requestLock` because the package's in-memory coalescing is isolate-local. Before network I/O, atomically move the delegation from `active` to `refreshing` with a unique lease owner. Hold or renew that lease through load, refresh, and persistence. A stale `refreshing` row, lost lease, or post-refresh persistence failure transitions only to `reauthorization_required`; it never retries or leases the old token generation again.

Retain every client assertion private key referenced by an active session or unexpired authorization transaction. The package records the `kid`, but a missing key raises a generic error without deleting a session. Publish the new public key and wait for cache propagation before selecting it for new grants. The service checks the recorded key ID before callback, restore, and refresh, and transitions unavailable-key state to reauthorization before removing an old key.

Dependencies: none.

### `W0.5` Prove Sigstore verification in workerd

Inspect a real `actions/attest-build-provenance` bundle and validate, outside this repository:

- Sigstore signature and transparency evidence.
- Artifact subject digest.
- Repository ID and URL.
- Commit SHA and ref.
- Workflow identity and SLSA builder fields.
- RFC `sourceRepository` and `builderId` mapping.

Output: a Workers-compatible verifier choice and exact field-mapping contract. Commit only the resulting spec/plan decision; fixture acquisition and experimentation remain external until `W2.5` implements the verifier.

Dependencies: `W0.1` provenance draft.

### `W0.6` Prove historical aggregator input

Result: complete. `subscribeRepos` firehose `#commit` events are the selected source.

Each `#commit` event provides: `seq` (relay-scoped ordering key, not comparable across relay and direct-PDS sources), `rev` (TID repo revision, per-repo logical clock), `since` (the `rev` of the preceding commit for this repo, the per-repo chain link), `commit` CID, `blocks` (CAR slice with signed commit and MST diff), `ops` (per-record operations with new CID and, for updates/deletes, `prev` CID), and `prevData` (previous MST root, required for inductive MST inversion). The signed commit is verifiable against the DID's signing key that was valid at the commit's `rev`. MST inversion against `prevData` requires inductive firehose state from the prior processed commit; it is not independently verifiable from a single event in isolation.

Jetstream (current production and the experimental archival rewrite under development), `getRepo`, `getRecord`, PDS repo history, and the `did:plc` audit log were evaluated and rejected: none provide event-specific record values with verifiable commit proof material for intermediate profile states. `#identity` events signal identity changes and require DID resolution; they do not carry key material.

Trust model, retention constraints, backfill limits, fork/rebase/tombstone handling, and explicit W10.1 constraints are documented in the Aggregator Changes section of the spec. Key constraints: `seq` is relay-scoped and must not be used for per-repo continuity — use `#commit.since` and `rev` instead; the relay backfill window is hours to days (not permanent); publishers active before the aggregator's subscription start can only be bootstrapped from current state via `getRepo`, with prior policy events marked unrecoverable; commit signature verification requires the key valid at the commit's `rev` and is not possible retroactively if that key is no longer in the DID document; persisting only the signed commit block is insufficient for later independent re-verification — the full MST proof slice (signed commit, record block, MST diff nodes) must be retained or the verification scope explicitly limited to ingest time; `#sync` and `tooBig` events break the inductive chain and require `getRepo` re-sync with the gap marked unrecoverable.

Dependencies: none.

### `W0.7` Decide public CLI shape

Use `emdash-plugin` as the v1 public command. A future `emdash plugin` alias is additive work, not a Gate 0 blocker.

Output: update the RFC examples and implementation documentation to use `emdash-plugin`.

Dependencies: none.

### W0 Completion

The RFC-derived work (`W0.1`, `W0.2`, `W0.5`, and `W0.7`) and OAuth custody validation (`W0.4`) are complete, so Gate 0A is complete. `W0.3` is deferred to `W12.7`. `W0.6` is complete: `subscribeRepos` firehose `#commit` events are the selected source, and Gate 0B is complete. An incompatible deployed-PDS result changes the support matrix or affected RFC guarantee before support is claimed or production launches.

## Workstream W1: Protocol and Lexicons

### `W1.1` Add package profile extension

Files:

- `packages/registry-lexicons/lexicons/com/emdashcms/experimental/package/profile.json`
- New `profileExtension.json`
- Generated exports and types.

Deliver:

- Optional `extensions` container.
- Signed repository anchor.
- `requireProvenance`, `confirmation`, and `approvers`.
- Semantic validation for DID uniqueness, policy values, and URL canonicalization.

Dependencies: `W0.1`.

### `W1.2` Add release provenance

Extend `releaseExtension.json` with the ratified provenance reference and add semantic validation for predicate, URL, checksum, source, and builder.

Dependencies: `W0.1`, `W0.5` field mapping.

### `W1.3` Regenerate and publish typed contracts

- Regenerate atcute types.
- Export value and type symbols from the package barrel.
- Add valid, absent-policy, unknown-predicate, and invalid fixture tests.
- Document experimental/stable NSID lookup through exported constants.

Dependencies: `W1.1`, `W1.2`.

### `W1.4` Preserve extensions in all profile writers

Update interactive publish and profile update paths, especially:

- `ProfileInput`.
- `buildProfileRecord`.
- `stampLastUpdated`.
- Profile update validation and CLI serialization.

Regression test: write strict policy, run a later ordinary interactive publish, and verify the extension survives unchanged.

Dependencies: `W1.1`.

### `W1.5` Add profile-policy editing to the local CLI core

Provide a profile-scoped, interactive-only operation that:

- Fetches and validates the current profile.
- Preserves unrelated extension data.
- Applies one policy edit.
- Uses `swapRecord` with the fetched CID.
- Never shares its OAuth session with the release service.

Dependencies: `W1.3`, `W1.4`.

### `W1.6` Update permission-set and namespace migration contracts

- Publish or update the experimental release permission set if applicable.
- Document that stable NSID migration requires reauthorization.
- Add a typed helper that returns the active release collection and scope string.

Dependencies: `W1.3`.

Merge boundary: land with `W1.7` so the exact scope contract is proved by the only API allowed to exercise it.

### `W1.7` Add create-only release publishing helper

Extend `registry-client` with a narrow delegated-release helper that:

- Constructs and validates the deterministic `<slug>:<version>` rkey.
- Serializes the canonical release record from verified inputs.
- Performs exactly one create through `createRecord` or a single-create `applyWrites` call.
- Exposes no update, delete, profile write, `putRecord`, or overwrite option.
- Returns the AT URI and CID needed for reconciliation.

Dependencies: `W1.3`, `W1.6`.

### W1 Completion

The protocol can represent every signed fact required by the service and installer, and existing tools cannot accidentally strip policy.

## Workstream W2: Shared Verification

Create `packages/registry-verification` and make its APIs usable in Workers and Node.

### `W2.1` Package scaffold and fixture corpus

- Add package build, exports, tests, and workerd compatibility job.
- Establish canonical fixture directories for records, tarballs, checksums, and Sigstore bundles.
- Define stable verification error codes shared by all consumers.

Dependencies: none; complete.

### `W2.2` Checksums and safe resource fetching

Extract and reconcile existing checksum behavior. Add manual redirects, byte/time limits, URL validation, DNS defense-in-depth, and injectable test transport. The dedicated verifier-Worker deployment boundary belongs to `W5.1a`; this package provides the transport-neutral safe-fetch primitive it invokes.

Dependencies: `W2.1`.

### `W2.3` Canonical plugin bundle validation

Unify CLI and core tar readers. Reject traversal, duplicate normalized paths, links, devices, duplicate manifests, gzip bombs, and limit violations. Return the validated manifest and canonical access.

Dependencies: `W2.1`.

### `W2.4` Declared-access canonicalization and escalation

Implement in `packages/plugin-types/src/declared-access.ts`:

- Canonical form.
- Equality.
- Structured diff.
- Escalation predicate.
- Stable digest input.

Drive implementation from the ratified `W0.2` table.

Dependencies: `W0.2`, `W1.3`.

### `W2.5` Provenance verification

Implement the `ProvenanceVerifier` interface and GitHub/SLSA v1 adapter proved in `W0.5`. Include trust-root update strategy and no partial-success state.

Dependencies: `W0.5`, `W1.2`, `W2.2`.

### `W2.6` Record and policy verification

Add helpers that:

- Validate profile and release lexicons.
- Normalize absent policy defaults.
- Match release package/rkey/version.
- Resolve the signed repository anchor.
- Verify required/optional/failed provenance semantics.
- Produce a structured verification report suitable for console, installer, and aggregator.

Dependencies: `W1.3`, `W2.2`, `W2.4`, `W2.5`.

Merge boundary: land with `W2.7`; the report contract is incomplete without authoritative direct-PDS inputs.

### `W2.7` Direct PDS read helpers

Extend `registry-client` with unauthenticated direct-PDS profile/release reads, bounded rkey enumeration, lexicon validation, and semver baseline selection. Do not route these helpers through the aggregator.

Dependencies: `W1.3`, `W0.2`.

### W2 Completion

Given the same profile, release, artifact, and provenance fixtures, service, installer, and aggregator receive the same verification result and error code.

## Workstream W3: OAuth, Crypto, and Passkeys

### `W3.1` Service encryption

Implement versioned AES-GCM envelope encryption with HKDF-derived purpose keys and associated row identity. Cover OAuth session blobs, DPoP keys, emails, webhook destinations, and webhook secrets.

Dependencies: none.

### `W3.2` Confidential client metadata and JWKS

Serve stable metadata and JWKS routes, support overlapping assertion keys, and validate deployment-derived client ID, redirects, scope declaration, and public origin.

Dependencies: `W0.4`, `W1.6` for final scope.

### `W3.3` D1 OAuth stores

Implement separate logical stores for:

- Console identity.
- Approver identity proof.
- Durable release delegation.

Persist only the release delegation after callback. Encrypt all sensitive state.

Dependencies: `W3.1`, `W3.2`.

### `W3.4` Session refresh coordination

Implement `PublisherCoordinator` with D1 leases, rotated-session CAS persistence, proactive refresh, jitter, reauthorization state, revocation, and ambiguous refresh recovery.

Dependencies: `W0.4`, `W3.3`, `W5.2a`.

### `W3.5` Console and approver identity sessions

- Convert successful `atproto` OAuth into short-lived, hashed, same-origin service sessions.
- Delete unneeded OAuth session material.
- Bind approver identity proof to invitation or requested DID.
- Add CSRF and session rotation.

Dependencies: `W3.3`, `W5.1` app scaffold.

### `W3.6` Required-UV passkey primitives

Extend `packages/auth` additively with configurable user verification and typed challenge context. Preserve existing CMS behavior by default.

Dependencies: none.

### `W3.7` Service passkey repository and ceremonies

- Multiple named credentials per DID.
- OAuth-before-registration.
- Required UV.
- Bound approval/rejection challenges.
- Atomic challenge consumption and counter update.
- Individual revocation requires fresh atproto identity proof and, when another active credential exists, an assertion from another credential.
- Last-credential recovery may proceed from fresh atproto proof alone, but emits a high-severity audit event and notifications to every affected publisher.
- Define minimal versioned credential-security events for enrolment, credential addition/removal, and recovery; write audit and outbox rows transactionally with each ceremony.

Dependencies: `W3.5`, `W3.6`.

Merge boundary: land with `W5.2c`; the repository is part of this service vertical, not a prerequisite merge.

### W3 Completion

The service can prove publisher and approver DIDs, hold only the exact writer grant, serialize refresh, and verify replay-resistant UV passkey ceremonies.

## Workstream W4: GitHub Workload Identity

### `W4.1` Issuer-neutral interfaces

Define `WorkloadIssuer`, `VerifiedWorkload`, policy matcher, and stable failure codes without GitHub-specific types leaking into intent orchestration.

Dependencies: `W5.1`.

Merge boundary: land with `W4.2` so the abstraction is proved by its first production adapter.

### `W4.2` GitHub JWT verification

Verify discovery, remote JWKS, issuer, audience, token times, immutable repository/owner IDs, workflow identity, ref, SHA, run ID, run attempt, and optional environment.

Dependencies: `W4.1`.

### `W4.3` Typed workload-policy model

Implement D1 repository and semantic matcher for repository, workflow, refs, and environments. No arbitrary expressions.

Dependencies: `W4.1`, `W5.1`.

Merge boundary: land with `W5.2b`; the repository is part of this workload-policy vertical.

### `W4.4` Submission evidence and cancellation identity

- Bind submission evidence to policy ID/version.
- Require matching repository, workflow, run ID, and run attempt for workload cancellation.
- Allow separately audited publisher-console cancellation.

Dependencies: `W4.2`, `W4.3`, `W5.3`.

### W4 Completion

A verified token maps to exactly one normalized workload identity and either one authorized package policy or a stable rejection.

## Workstream W5: Service Persistence and Orchestration

### `W5.1` Worker application scaffold

Create `apps/release-service` using the aggregator's Cloudflare Vite and workers-vitest patterns. Add D1, Queues, DLQs, cron, static assets, generated Worker types, health route, and fail-closed configuration validation.

Dependencies: none.

### `W5.1a` Dedicated verifier Worker

Implement the isolated Worker used for artifact, provenance, and webhook egress. It exposes a narrow typed service binding, applies `W2.2` safe-fetch limits, and has no D1, Queue, service-secret, VPC, or private-origin bindings. Add workerd tests for redirects, size/time limits, malformed responses, and service-binding failure behavior.

Dependencies: `W2.2`, `W5.1`.

### `W5.2` D1 repository slices

Do not land the entire service schema as one horizontal merge. Each slice includes only the migrations, repository methods, real-D1 tests, ownership constraints, and indexes required by its first service operation:

- `W5.2a`: publisher accounts, OAuth transactions, console sessions, and delegations. Lands with `W3.2` and `W3.3`.
- `W5.2b`: workload policies. Lands with `W4.3`.
- `W5.2c`: approver identities, credentials, invitations, challenges, and the shared audit/outbox foundation needed for credential-security events. Lands with `W3.7`.
- `W5.2d`: workload JWT replay reservations, release targets, intents, submission outbox, and audit. Lands with `W5.3` and `W5.7a`.
- `W5.2e`: notification endpoints and delivery attempts. Lands with `W7.2`.
- `W5.2f`: append-only approvals and approval-lifecycle outbox. Lands with `W5.5`.

Every applicable slice includes owner columns, unique constraints, indexes, and CAS/lease fields. `W5.2d` introduces a cryptographically random `public_intent_id` distinct from internal row identifiers; no external surface exposes the internal ID.

Dependencies: `W5.1` and the contracts consumed by each slice.

### `W5.3` Intent submission

- Verify OIDC before remote fetch.
- Reject publishers excluded by the deployment's allowed-publisher policy before creating state or fetching user-controlled URLs.
- Hash and reserve the raw JWT until expiry, then reserve the idempotency key and release target atomically.
- Create intent, audit event, and validation outbox row in one D1 batch.
- Return stable `202`, duplicate, and conflict responses.
- Keep the public submission route unregistered until `W5.6` lands the publication consumer.

Dependencies: `W1.3`, `W4.2`, `W4.3`.

Merge boundary: land with `W5.2d` and `W5.7a`. This merge proves transactional outbox draining but exposes no route that can accept an intent before a validation consumer exists.

### `W5.4` Validation worker

- Resolve DID and PDS.
- Fetch signed profile and baseline releases.
- Validate artifacts, manifest access, and provenance.
- Derive signed policy, escalation, approval requirement, approval digest inputs, and expiry.
- Transition by CAS and write outbox events.

Dependencies: `W2.3`, `W2.6`, `W2.7`, `W5.1a`, `W5.3`, `W5.7a`.

### `W5.5` Approval and rejection lifecycle

- Revalidate profile and baseline before challenge creation.
- Before returning substantive approval details, issuing a challenge, or accepting approval/rejection, fetch the current profile policy and require the authenticated approver DID to remain listed. An unauthenticated approval URL reveals only minimal package/status data and the login action.
- Recompute approval digest before challenge verification.
- Store append-only approval/rejection evidence.
- Invalidate approval when any bound fact changes.
- Transition approved intent to publish queue.
- Keep approval and rejection mutation routes unregistered until `W5.6` lands the publication consumer.

Dependencies: `W3.7`, `W5.4`.

Merge boundary: include `W5.2f` approval persistence in this lifecycle vertical.

### `W5.6` Final verification and PDS publication

- Add the idempotent publication Queue consumer.
- Re-run full verification.
- Acquire publisher publication/session lease.
- Create one deterministic release record.
- Reconcile timeout or transport ambiguity by direct read and canonical comparison.
- Distinguish published, confirmed absent/retryable, immutable conflict, and reauthorization-required.
- Register submission, approval, and rejection routes only after validation and publication consumers are active.

Dependencies: `W1.7`, `W3.4`, `W5.4`, `W5.5`.

### `W5.7` Outbox, Queues, cron, and recovery

This work lands as two merge units rather than one horizontal infrastructure change.

#### `W5.7a` Outbox and Queue infrastructure

Land the transactional outbox drainer, Queue dispatch plumbing, DLQ forensics, and bounded retry primitives before connecting lifecycle operations to real queues.

Dependencies: `W5.1`.

Merge boundary: land with `W5.2d` and `W5.3`; lifecycle-specific Queue consumers still land with their operations.

#### `W5.7b` Lifecycle recovery and maintenance

Add stage expiry, lease reclamation, publishing reconciliation, proactive OAuth refresh, and bounded pruning after publication semantics are stable.

Dependencies: `W3.4`, `W5.6`, `W5.7a`.

### `W5.8` Versioned JSON API foundation

Land only shared response envelopes, stable error-code serialization, request IDs, authentication/CSRF primitives, owner checks, pagination conventions, and API-schema generation here. CI, publisher, and approver endpoints land vertically with the operation they expose. Enforce the deployment's allowed-publisher policy on publisher login/delegation and every CI submission. Expose only `public_intent_id` for intent addressing; internal row IDs never cross the API boundary.

Dependencies: `W5.1`. Each endpoint depends on its own service operation and repository slice.

### W5 Completion

Gate 2 passes with real D1, Queue redelivery, and fake-PDS integration tests.

## Workstream W6: Publisher and Approver Console

### `W6.1` Console foundation

- React SPA through Worker static assets.
- Kumo component setup.
- Lingui extraction and locale loading.
- `LocaleDirectionProvider` and logical classes.
- Authenticated router, API client, error boundaries, and session expiry behavior.

Dependencies: `W3.5`, initial `W5.8` session endpoints.

### `W6.2` Publisher overview and delegation

Show delegation scope, PDS, status, refresh health, assertion key, revoke, and reauthorize flows. Never imply key removal revokes current access tokens immediately.

Dependencies: `W3.4`, delegation endpoints in `W5.8`.

### `W6.3` Packages and workload policies

- Read-only signed profile policy.
- Listed-versus-enrolled approver matrix.
- Typed GitHub repository/workflow/ref/environment editor.
- Generate local CLI command for signed profile-policy changes.

Dependencies: `W4.3`, package/policy endpoints, `W8.3` command contract.

### `W6.4` Intent and approval views

- Lifecycle timeline.
- Workload evidence.
- Artifact and provenance checks.
- Baseline and structured access diff.
- Approval, rejection, blocked, expired, conflict, and revalidation states.

Dependencies: `W5.4`, `W5.5`, approval endpoints.

### `W6.5` Passkey and enrolment UI

- Invitation acceptance.
- atproto identity callback.
- Multiple credential registration, naming, listing, and revocation.
- High-severity recovery warnings.
- No enrol-and-approve combined action.

Dependencies: `W3.7`, passkey endpoints.

### `W6.6` Notifications and audit UI

- Verified email configuration.
- Webhook creation, one-time secret display, event selection, test, rotation, and failure state.
- Paginated audit filters and export.

Dependencies: `W7`, audit endpoints.

### `W6.7` Localization, accessibility, and RTL completion

- No hard-coded user-facing strings.
- Keyboard and screen-reader pass.
- Arabic end-to-end pass.
- WebAuthn status and error announcements.
- Mobile approval review remains usable without hiding security details.

Dependencies: all `W6` screens.

### W6 Completion

Every service-local publisher and approver operation is available through the console without direct D1 access.

## Workstream W7: Notifications

### `W7.1` Notification event contract

Extend the credential-security event contract from `W3.7` with versioned release-lifecycle event types and safe payloads. Separate internal event data from the intentionally minimal email/webhook payload.

Dependencies: `W3.7` and lifecycle contract from `W5.4` through `W5.7`.

### `W7.2` Endpoint ownership and verification

- Explicit publisher owner on every endpoint.
- Optional approver recipient.
- Email verification.
- Webhook URL validation and test delivery through the shared verifier/egress boundary.
- Event allowlists and disabled state.

Dependencies: `W2.2`, `W3.1`, `W5.1`, `W5.1a`.

Merge boundary: land with `W5.2e`; the repository is part of the notification-endpoint vertical.

### `W7.3` Email adapter

Implement Cloudflare Email Service behind `Mailer`, with text and HTML templates, localized copy where recipient locale is known, and no sensitive intent detail in mail.

Dependencies: `W7.1`, `W7.2`.

### `W7.4` Signed webhook adapter

- Stable delivery ID and event schema version.
- Timestamped HMAC over raw body.
- Dedicated untrusted-egress boundary.
- Retry, jitter, DLQ, disable threshold, and secret rotation overlap.

Dependencies: `W2.2`, `W7.1`, `W7.2`.

### `W7.5` Delivery dispatcher

Consume outbox events, materialize per-endpoint deliveries, deduplicate, record attempts, and surface failures to console and audit.

Dependencies: `W5.7`, `W7.3`, `W7.4`.

### W7 Completion

Every lifecycle and credential-security event reaches configured destinations with at-least-once, auditable delivery.

## Workstream W8: CLI and GitHub Action

### `W8.1` Shared delegated-service API client

Add `packages/registry-client/src/delegated` with typed requests, envelopes, polling, idempotency, stable errors, and no browser-specific dependency.

Dependencies: API schemas from `W5.8`.

### `W8.2` Delegation command

Open the service authorization flow, wait for completion, display exact granted scope and service origin, and report reauthorization requirements.

Dependencies: `W3.2` through `W3.5`, `W8.1`.

### `W8.3` Profile policy command (complete)

Delivered by `W1.5` in #1925, including add/remove approver, confirmation, provenance requirement, conflict handling, and JSON output. This is not a future merge unit.

### `W8.4` Enrol and approve commands

Open service-hosted browser ceremonies and wait for a terminal result. Do not attempt WebAuthn in the terminal.

Dependencies: `W3.7`, approval API, `W8.1`.

### `W8.5` Release submit, status, and cancel commands

- Build request from local manifest/artifact/provenance inputs.
- Acquire workload token only in CI-supported mode.
- Poll until published, awaiting approval, or terminal failure.
- Emit stable JSON for automation.

Dependencies: `W5.8`, `W8.1`.

### `W8.6` Official GitHub Action

- Request an audience-scoped OIDC token.
- Submit with deterministic idempotency input.
- Poll status.
- Output intent ID, status, approval URL, and release URI.
- Support cancellation from the same run identity.
- Accept no atproto secret.

Dependencies: `W4`, `W5.8`, `W8.1`.

### W8 Completion

First-time delegation and steady-state automated release work through documented commands and the official Action.

## Workstream W9: Installer Enforcement

### `W9.1` Replace duplicate integrity helpers

Move core artifact checksum, tar, and manifest consistency checks to `@emdash-cms/registry-verification` without behavior regression for existing releases.

Dependencies: `W2.2`, `W2.3`, `W2.4`.

### `W9.2` Fetch signed profile policy and provenance

Extend direct-PDS install resolution to validate profile and release extensions and retain the profile CID used for the decision.

Dependencies: `W1.3`, `W2.6`, `W2.7`.

### `W9.3` Enforce provenance semantics

- Optional and absent: install with explicit unattested status.
- Required and absent: block.
- Present and valid: continue.
- Present and failed/unverifiable: block, regardless of policy default.

Dependencies: `W9.1`, `W9.2`.

### `W9.4` Admin consent and provenance UI

Show source, builder, workflow identity, verification status, and precise errors without presenting provenance as a safety guarantee. Localize and test RTL.

Dependencies: `W9.3`.

### `W9.5` Historical-policy limitation handling

Apply current signed policy as a conservative direct-install floor and expose when historical policy-at-publication is unavailable. Never trust the aggregator to relax a current signed requirement.

Dependencies: `W9.2`, RFC clarification.

### W9 Completion

Gate 3 installer criteria pass against valid, absent, tampered, foreign-source, and unknown-predicate fixtures.

## Workstream W10: Aggregator Enforcement

### `W10.1` Event-specific ingest source

Replace or extend current Jetstream/current-record ingestion with the `W0.6` proved source. Carry ordering key, event CID, repo revision, record value, and proof blocks through Queue jobs.

Dependencies: `W0.6`.

### `W10.2` Policy history schema and ingest

- Persist every package policy event.
- Classify tightening, weakening, and approver changes.
- Associate each release with the last preceding profile event.
- Handle profile/release arrival reordering through pending state and retry.

Dependencies: `W1.3`, `W10.1`.

### `W10.3` Historical policy reclassification

- Associate each release with its event-specific policy state.
- Combine the existing provenance verification result with the historical policy in force at publication.
- Reclassify policy compliance by CAS without repeating cryptographic verification when inputs are unchanged.
- Record stable reasons and the associated policy-event ID.

Dependencies: `W10.2`, `W10.4`.

### `W10.4` Minimum default filtering

Before hosted beta, persist the release provenance reference and current signed policy digest, queue shared verification, and CAS provenance status from `pending` to `valid`, `invalid`, or `unverifiable`. Expose status and exclude releases that are pending, invalid, or unverifiable when current signed policy requires provenance. This is a conservative current-policy floor and does not claim historical policy-at-publication accuracy.

Dependencies: `W1.3`, `W2.6`; does not wait for `W10.1`.

### `W10.5` Accurate policy-at-publication views

Update latest-release, search, package, and audit views to use the associated historical policy event. Explicit audit reads may include violating releases with reasons.

Dependencies: `W10.2`, `W10.3`.

### `W10.6` Downgrade cooldown and notification

- Detect `requireProvenance: true -> false`.
- Continue enforcing the strict prior floor through configured cooldown.
- Notify signed security contacts through the approved channel.
- Audit legitimate expiry and repeated downgrade transitions.

Dependencies: `W10.2`, `W7` notification adapter or an explicitly separate aggregator notifier.

### `W10.7` Reconciliation and backfill

Backfill current records and available historical events, retry pending policy associations, reverify stale provenance, and preserve immutable duplicate-release behavior.

Dependencies: `W10.2`, `W10.3`, `W10.5`.

### W10 Completion

Gate 5 aggregator criteria pass under event reordering, rapid profile transitions, queue delays, retries, and backfill.

## Workstream W11: Operations and Self-Hosting

### `W11.1` Deployment configuration

Define fail-closed Worker bindings and variables for D1, Queues, DLQs, static assets, verifier Worker, email, public origin, OAuth metadata, GitHub audience, encryption keys, and allowed publisher policy.

Dependencies: `W5.1`, `W5.1a`, `W7` binding choices.

### `W11.2` Key and session operations

Runbooks and tooling for:

- Client assertion key overlap and removal.
- Application encryption-key migration.
- Webhook secret rotation.
- Publisher revocation and reauthorization.
- Compromised deployment emergency response.

Dependencies: `W3.1` through `W3.4`, `W7.4`.

### `W11.3` Observability and alerts

Implement metrics and structured logs for lifecycle latency, validation failures, OAuth refresh, lease contention, PDS ambiguity, approval expiry, Queue age, DLQs, and delivery failures. Add security alerts listed in the spec.

Dependencies: service lifecycle stabilized in `W5`, notification lifecycle in `W7`.

### `W11.4` Abuse controls

- Rate limits by publisher, policy, package, and source.
- Active-intent and remote-byte quotas.
- OIDC replay and policy-mismatch detection.
- Strict CSP, cookies, origin, and framing policy.
- Log/Sentry redaction tests.

Dependencies: `W4`, `W5`, `W6`.

### `W11.5` Backup, restore, and audit export

Document and test D1 backup/export, encrypted-row restore, intent/audit export, and recovery after Queue loss. Restoration must not duplicate PDS releases.

Dependencies: `W5.7`, `W3.1`.

### `W11.6` Workers self-hosting path

Provide a deployment template and guide that creates D1, Queues, DLQs, cron, verifier Worker, email adapter, OAuth keys, and secrets in another Cloudflare account. Include a post-deploy conformance command.

Dependencies: `W11.1` through `W11.5`.

### W11 Completion

An operator can deploy, monitor, rotate, back up, restore, revoke, and incident-respond without undocumented database edits.

## Workstream W12: Conformance and Security

This workstream owns cross-component testing. Unit and workstream integration tests remain with their implementation workstreams.

### `W12.1` Shared conformance fixtures

Version fixtures for profiles, releases, access diffs, GitHub tokens, Sigstore bundles, service API responses, aggregator events, and installer outcomes. Every component imports fixtures rather than copying JSON.

Dependencies: `W1`, `W2`, `W4` contracts.

### `W12.2` Real workerd integration suite

Cover D1 migrations, Queues, DLQs, cron, OAuth stores, refresh contention, state CAS, outbox recovery, expiry, encryption, and verifier Worker calls.

Dependencies: `W3`, `W5`, `W7`.

### `W12.3` Browser/WebAuthn suite

Using the existing virtual authenticator pattern, cover multiple credentials, UV rejection, challenge replay, separate enrolment/approval, removal authorized by another active credential, last-credential OAuth recovery, affected-publisher notifications, rejection, Arabic RTL, accessibility, and mobile approval review.

Dependencies: `W3.7`, `W6`.

### `W12.4` End-to-end protocol suite

Run fake GitHub issuer -> release service -> test PDS -> aggregator -> clean EmDash installer. Include automatic, approval-required, tampered, changed-profile, changed-baseline, ambiguous-write, and downgrade cases.

Dependencies: `W5`, `W8`, `W9`, `W10`.

### `W12.5` Adversarial and fuzz testing

- Tar and Sigstore parser fuzzing.
- URL, redirect, DNS, and webhook SSRF cases.
- OIDC claim confusion and replay.
- OAuth refresh race and key rotation.
- Cross-tenant endpoint and intent authorization.
- Allowed-publisher rejection at console login/delegation and CI submission.
- Guessing and internal-row-ID attempts against public intent routes.
- Approval digest mutation and cross-action replay.
- Queue duplicate, reorder, poison, and DLQ behavior.

Dependencies: feature-complete implementations.

### `W12.6` External security review

Review scope includes service compromise blast radius, OAuth custody, DPoP storage, encryption/key rotation, WebAuthn ceremonies, OIDC policy, PDS reconciliation, parser boundaries, notification egress, and tenant isolation.

Dependencies: Gates 2 and 3.

### `W12.7` Self-host and production smoke

First provision a fresh Workers/D1 self-host from `W11.6` and run the same delegated-release conformance suite used for the hosted service. Complete the `W0.3` compatibility matrix against every PDS implementation for which support will be claimed, with a Bluesky-hosted PDS and at least one supported alternative as the minimum set: authorize the exact create-only scope, create a release, reject release update/delete, reject profile create/update and unrelated collection writes, and verify revocation and client-key removal before and after access-token expiry. Then use a controlled GitHub repository, real OIDC, the hosted service, production aggregator, and a disposable EmDash site. Verify rollback disables new submissions without invalidating published records or losing staged audit data.

Dependencies: `W11.6` and Gates 1 through 4; completes `W0.3`; final hosted production run after Gate 0B and the Gate 5 `W10` implementation prerequisites.

### W12 Completion

No unresolved critical/high security findings, the `W0.3` compatibility matrix passes for every claimed-supported PDS with at least the required two-PDS minimum, all conformance suites pass, and the production smoke completes Gate 5.

## Recommended Merge Sequence

Completed work is recorded in the implementation baseline instead of remaining in the future queue. The next merge units are:

| Sequence | Merge unit                                                   | Depends on                                |
| -------- | ------------------------------------------------------------ | ----------------------------------------- |
| 1        | `W2.6` + `W2.7` record verification and direct-PDS reads     | Completed W1/W2 contracts                 |
| 2        | `W1.6` + `W1.7` exact scope and create-only publishing       | Completed W1 contracts                    |
| 3        | `W3.6` required-UV and typed challenge primitives            | None                                      |
| 4        | `W5.1` service scaffold and `W5.8` API foundation            | None; sensitive routes remain unreachable |
| 5        | `W4.1` + `W4.2` issuer contract and GitHub verifier          | `W5.1`                                    |
| 6        | `W5.1a` dedicated verifier Worker                            | `W2.2`, `W5.1`                            |
| 7        | `W3.1` encryption                                            | None                                      |
| 8        | `W3.2` + `W3.3` confidential OAuth and `W5.2a` custody slice | `W1.6`, `W3.1`, `W5.1`                    |
| 9        | `W4.3` workload policy and `W5.2b` repository slice          | `W4.1`, `W5.1`                            |
| 10       | `W5.2d` + `W5.3` + `W5.7a` unreachable submission pipeline   | `W4.2`, `W4.3`, API foundation            |
| 11       | `W5.4` validation consumer, routes remain unreachable        | `W2.6`, `W2.7`, `W5.1a`, `W5.3`, `W5.7a`  |

Later work continues as vertical merge units: passkey storage with ceremonies, approval storage with lifecycle, publication with reconciliation, notification storage with adapters, and API endpoints with their operations. `W10.1` begins only after Gate 0B; minimum current-policy filtering in `W10.4` may proceed earlier.

## Parallelization Map

Current parallel work:

- `W2.6` + `W2.7`, `W3.1`, `W3.6`, and `W5.1` may proceed independently. `W4.1` + `W4.2` and `W5.1a` begin after `W5.1` establishes their app and binding boundaries.
- `W1.6` + `W1.7` and `W3.2` + `W3.3` close the exact delegation boundary.
- `W4.3`, then `W5.2d` + `W5.3` + `W5.7a`, establish the unreachable submission pipeline. `W5.4` adds validation while routes remain unreachable until publication lands in `W5.6`.
- `W0.6` external research may proceed concurrently and commit only conclusions to this branch.

After Gate 0B:

- `W10.1` and historical policy association may proceed independently of service orchestration.

After Gate 1:

- `W5` validation and publication become the main integration path.
- `W9` installer work can proceed independently against shared fixtures.
- `W10.3` provenance processing can proceed once event-specific policy association exists.

After Gate 2:

- `W6`, `W7`, and `W8` can proceed in parallel against the stable API.
- `W11` can add production bindings, observability, and runbooks.
- `W12` can begin full cross-component suites.

## Dependency Risks

| Risk                                                       | Impacted work            | Required response                                                                                  |
| ---------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| Supported PDS rejects create-only scope                    | `W3`, `W5`, `W8`         | Change RFC/support matrix; never add broad fallback.                                               |
| Patched Sigstore dependency regresses or cannot be updated | `W2`, `W5`, `W9`, `W10`  | Retain packed-output workerd tests; replace the pinned patch only with reviewed upstream behavior. |
| Historical profile values cannot be recovered              | `W10`, production launch | Redesign history source or revise RFC downgrade guarantees before Gate 5.                          |
| Profile extension shape changes after implementation       | `W1`, all consumers      | Block downstream schema work until ratification; regenerate fixtures together.                     |
| D1 refresh lease proves unsafe under real atcute behavior  | `W3`, `W5`               | Introduce per-publisher DO coordinator behind `PublisherCoordinator`, keeping D1 canonical.        |
| GitHub changes attestation identity or predicate fields    | `W2`, `W4`               | Fail closed, add a real fixture, and ratify the mapping before accepting the new shape.            |
| Verifier Worker cannot enforce required egress policy      | `W2`, `W7`, self-hosting | Require controlled egress proxy for deployments with private connectivity.                         |

## Definition of Done for Every Work Item

- Intended behavior and failure behavior are both tested.
- New persisted state has a forward-only migration and real D1 test.
- New async work is idempotent under duplicate and reordered delivery.
- New API behavior has a stable error code and API-client coverage.
- Security-sensitive comparisons use canonical forms and constant-time comparison where applicable.
- No secrets or private notification data appear in logs, errors, fixtures, or snapshots.
- User-facing strings are localized and new layouts pass RTL review.
- Package changes include an appropriate changeset.
- `pnpm build`, targeted tests, `pnpm lint:quick`, and relevant typechecks pass.
- The workstream's integration gate documentation is updated with actual verification evidence.

## Current Execution Set

Start these independently, with at most three implementation branches active at once:

1. `W2.6` + `W2.7`: structured record/policy verification over authoritative direct-PDS reads.
2. `W1.6` + `W1.7`: implement the typed exact scope and narrow create-only publishing helper.
3. `W0.6`: complete. Gate 0B is closed.
4. `W3.6`: required-UV passkey primitives.
5. `W5.1` + `W5.8`: unreachable service and API foundations.
6. After `W5.1`, `W4.1` + `W4.2` and `W5.1a`: workload verification and the isolated verifier Worker.

Do not implement historical policy association or cooldown claims until Gate 0B passes. Deployed-PDS compatibility remains mandatory in `W12.7` before claiming support or launching production.
