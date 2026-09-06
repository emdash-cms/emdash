# Delegated release service operations

This runbook covers self-host deployment, routine maintenance, and incident recovery for the delegated release service. The service is experimental and must not be deployed until the complete implementation stack and conformance gates have been accepted.

## Operational invariants

- Publisher and approver Durable Objects are authoritative for retained authority and decisions.
- The identity directory is a non-authoritative projection split across 256 Durable Objects. Deleting it does not change authority, release state, or approval state.
- The initial deployment does not use D1. The operator console performs direct DID lookup and uses the sharded identity directory for fleet maintenance.
- `PUBLICATION_STAGING` is private transient storage. Published release records reference only publisher-PDS blobs; they never reference staging objects or artifact source URLs.
- `PROVENANCE_STORE` is private immutable storage exposed only through the checksum-addressed provenance route.
- R2 snapshot pages are encrypted before storage. Audit export objects contain only the sanitized `audit_events.public_payload` contract.
- Restore requires a suspended publisher and a complete, decryptable archive manifest.
- Restore clears retained OAuth authority and pending workflow connection requests, disables workload policies, and converts nonterminal intents to `failed`. A publisher must reauthorize before publication resumes.
- Operators use supported Access routes and clients. Runbooks never require direct Durable Object SQLite edits.

## Cloudflare resources

The release-service Worker expects the following resources.

| Binding                      | Resource                         | Purpose                                                                                                          |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLISHER_DO`               | `PublisherDurableObject`         | Per-publisher delegation, workflow connection, policy, intent, publication, audit, restore, and rate-limit state |
| `APPROVER_DO`                | `ApproverDurableObject`          | Per-approver sessions, passkeys, decisions, audit, and encrypted OAuth transactions                              |
| `SERVICE_CONTROL_DO`         | `ServiceControlDurableObject`    | Global pause mode, publisher suspension, publication permits, and operator audit                                 |
| `IDENTITY_DIRECTORY_DO`      | `IdentityDirectoryDurableObject` | Non-authoritative publisher and approver inventory, sharded by DID hash                                          |
| `RELEASE_INTENT_WORKFLOW`    | Workflow                         | Verification, approval wait, publication, and reconciliation                                                     |
| `PUBLISHER_ARCHIVE_WORKFLOW` | Workflow                         | Bounded, retryable publisher snapshot and audit export                                                           |
| `RELEASE_VERIFIER`           | Service binding                  | Isolated artifact and provenance verification                                                                    |
| `PUBLICATION_STAGING`        | Private R2 bucket                | Transient checksum-verified package and image bytes awaiting PDS blob upload                                     |
| `PROVENANCE_STORE`           | Private R2 bucket                | Immutable verified Sigstore bundles referenced by published releases                                             |
| `OPERATIONS_ARCHIVE`         | R2 bucket                        | Encrypted publisher snapshot pages and append-only sanitized audit pages                                         |
| `OPERATIONS_METRICS`         | Analytics Engine dataset         | Privacy-safe operational alert events                                                                            |
| `ASSETS`                     | Worker static assets             | Publisher, approver, and Access operator web surfaces                                                            |

The initial Durable Object migration tag is `v1`. It contains every class required before the first deployment. Each publisher object initializes its complete schema, including short-lived `workflow_connection_invitations` and `workflow_connection_requests`, before serving requests.

## Configure a self-hosted deployment

### Public origin and OAuth

Set the following non-secret variables in `apps/release-service/wrangler.jsonc`:

- `PUBLIC_ORIGIN`: the canonical HTTPS custom origin, without a trailing path;
- `DEPLOYMENT_ID`: a stable identifier that remains unchanged across deployments and key rotations;
- `OAUTH_REDIRECT_URIS`: a JSON array containing `${PUBLIC_ORIGIN}/oauth/callback`;
- `ACCESS_TEAM_DOMAIN`: the exact HTTPS issuer origin for Cloudflare Access, including a custom Access hostname when configured, without a port or path;
- `ACCESS_VIEWER_AUD`, `ACCESS_REVIEWER_AUD`, and `ACCESS_ADMIN_AUD`: a distinct Access application audience or a JSON array of up to eight distinct audiences for the role described below. Use multiple applications when the exact route set exceeds the Access destination limit.

Changing `DEPLOYMENT_ID` makes existing encryption envelopes unreadable because the deployment identifier is part of the authenticated encryption context.

### Cloudflare Access

Create Access applications whose path specificity supplies the audience required by each route family.

| Audience | Paths                                                                                        | Capability                                                                         |
| -------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Viewer   | `/admin*`, `/admin/api/status`, `/admin/api/directory`, read-only publisher and audit routes | Load the operator console and inspect state                                        |
| Reviewer | `/admin/api/intents/*`                                                                       | Cancel or reconcile release intents                                                |
| Admin    | `/admin/api/pause`, `/admin/api/publishers/*`, `/admin/api/approvers/*`                      | Pause publication, suspend or revoke publishers, rotate keys, archive, and restore |

The Worker verifies the Access JWT issuer and the route-specific audience. Access group claims do not grant a role inside the Worker.
Every configured audience must be unique across all three roles.

### Secrets

Set the assertion key set and encryption keyring as Worker secrets. Do not pass their values as command arguments.

```sh
cd apps/release-service
pnpm exec wrangler secret put OAUTH_ASSERTION_KEYSET
pnpm exec wrangler secret put ENCRYPTION_KEYRING
```

`OAUTH_ASSERTION_KEYSET` contains the active confidential-client assertion key and any previous public keys still needed by an authorization server. `ENCRYPTION_KEYRING` contains the active encryption key and retained decryption keys.

The base configuration uses Worker secret bindings. `loadConfiguration()` also accepts `SecretsStoreSecret` bindings and resolves each value with `get()` on every load, so key rotation is visible to the configuration cache. Define Secrets Store bindings in a deployment-specific Wrangler environment. Do not commit a Secrets Store ID to the reusable base configuration.

### R2 and verifier

Create separate private buckets for transient publication staging and encrypted operations archives before deploying the service.

```sh
pnpm exec wrangler r2 bucket create emdash-release-service-publication-staging
pnpm exec wrangler r2 bucket create emdash-release-service-provenance
pnpm exec wrangler r2 bucket create emdash-release-service-operations
```

Add a seven-day expiry rule for the deterministic `publication/` staging prefix:

```sh
pnpm exec wrangler r2 bucket lifecycle add \
  emdash-release-service-publication-staging \
  expire-publication-staging \
  publication/ \
  --expire-days 7
```

Add the same recovery bound for workflow uploads:

```sh
pnpm exec wrangler r2 bucket lifecycle add \
  emdash-release-service-publication-staging \
  expire-workload-staging \
  workload/ \
  --expire-days 7
```

The Workflow deletes staging objects after it commits every PDS blob receipt and the canonical blob-only release record in the publisher Durable Object. The lifecycle rule is a recovery bound for objects left by an interrupted Workflow; it does not replace normal cleanup. Keep both buckets private and do not attach a public custom domain.

Deploy the release verifier under the service name `emdash-release-verifier` before the release-service Worker. The release-service Worker calls it through the `RELEASE_VERIFIER` service binding rather than public HTTP.

### Validate the deployment artifact

Generate binding types, run the Worker and UI tests, and build the production artifact before deployment.

```sh
cd apps/release-service
pnpm exec wrangler types --check
pnpm test
pnpm build
pnpm exec wrangler deploy --dry-run
```

After deployment, `GET /health` must return `200` without loading configuration. `GET /ready` returns `200` only after configuration loads, the service-control Durable Object initializes, and its active encryption-key version matches `ENCRYPTION_KEYRING.current`.

Test the account and workflow connection journey against the deployed origin:

1. Sign in once with a test Atmosphere account and confirm the account dashboard loads publishing state, connected workflows, recent releases, activity, and any existing approval passkeys.
2. Create a connection invitation for the test plugin and store it as the `EMDASH_CONNECTION_INVITATION` GitHub Actions secret.
3. Run the permanent release Action in a test GitHub Actions job with `id-token: write` and no existing workload policy.
4. Confirm the job summary contains the workflow approval URL and the Action remains waiting.
5. Confirm the browser shows the expected repository, workflow file, branch or tag, and environment. Verify no workload policy exists before browser confirmation.
6. Confirm the connection and verify the resulting workload policy contains the immutable GitHub repository and owner IDs plus the selected ref scope and environment.
7. Confirm the waiting Action requests fresh OIDC, creates the release intent, and continues normally.

List the staging lifecycle rules and confirm that `expire-publication-staging` and `expire-workload-staging` target their respective prefixes with a seven-day expiry:

```sh
pnpm exec wrangler r2 bucket lifecycle list emdash-release-service-publication-staging
```

## Operations directory

Successful publisher and approver OAuth callbacks register the DID in one of 256 directory Durable Objects before issuing an application session or retaining release delegation. Directory registration failure emits `directory_failure`, fails the callback, and leaves no new application session or delegated authority.

The operator console skips empty partitions when listing publishers or approvers. API clients can resume one partition at a time with `ReleaseServiceOperatorClient.listDirectory()`. Fleet operations must retain the returned cursor until it becomes absent.

Rebuild a missing directory as publishers and approvers complete OAuth again. Directory rows are not evidence of active delegation or approver eligibility; query each authoritative shard before acting. Do not start fleet key verification or retire a key until every lost directory partition has been rebuilt.

## Rotate encryption keys

### Routine rotation

1. Pause publication in the operator console.
2. Add the new key version to `ENCRYPTION_KEYRING`, retain every old key, and set `current` to the new version.
3. Deploy the keyring change without removing old keys.
4. Select **Activate configured key**. The service records the previous version as readable and keeps readiness closed until the configured and controlled active versions match.
5. Enter the previous version and select **Start fleet verification**. The Workflow scans every publisher and approver in all 256 directory partitions, rotates retained ciphertext with compare-and-set writes, and requires two consecutive zero-change passes for each shard.
6. Refresh the key status until the Workflow verification record appears. Confirm that no `refresh_failure`, `archive_gap`, or `restore_failure` event appeared during the campaign.
7. Remove the previous version from `ENCRYPTION_KEYRING` and deploy the reduced keyring.
8. Refresh the key status, enter the removed version, and select **Retire removed key**. Retirement fails unless publication remains paused, the active version has a completed fleet verification, and the retired version is absent from the configured keyring.
9. Restore the previous service mode.

Rotation decrypts and re-encrypts outside the Durable Object storage transaction. Each replacement uses a ciphertext compare-and-set, so concurrent refresh or OAuth completion wins safely and causes another verification pass. The per-publisher and per-approver rotation controls remain available for diagnosing a failed Workflow shard.

### Compromised encryption key

1. Pause publication immediately.
2. Revoke affected publisher delegation when retained state cannot be trusted.
3. Activate a new encryption key while retaining the compromised key only for the bounded rotation window.
4. Run fleet verification and wait for its recorded two-pass result.
5. Remove and retire the compromised key after verification completes.
6. Require reauthorization for every publisher whose ciphertext could not be proved readable and authentic.

## Archive publisher shards

Use `Start archive workflow` in the operator console or `ReleaseServiceOperatorClient.startPublisherArchive()`. The Workflow writes bounded pages in this order:

1. sanitized publisher and delegation metadata;
2. disabled-capable workload policy records;
3. canonical intent rows;
4. sanitized audit events;
5. an encrypted completion manifest.

Short-lived workflow connection requests are not archived. A restored publisher must run and confirm its permanent release workflow before replacing a disabled workload policy.

Snapshot objects use the following prefix:

```text
snapshots/{publisherHash}/{archiveId}/
```

Sanitized audit pages use this prefix and never overwrite an existing sequence range:

```text
audit/{publisherHash}/{firstSequence}-{lastSequence}-{contentDigest}.json
```

The content digest keeps audit histories append-only when recovery resets a shard's local audit sequence. Snapshot writes use create-only R2 conditions. A retried page decrypts and compares the existing object; different content at the same key fails with `ARCHIVE_OPERATION_FAILED`.

## Restore a publisher shard

Preparing a restore deletes publisher state. Confirm the DID and archive ID before continuing.

1. Pause publication or suspend the publisher through the operator console.
2. Confirm that the selected archive has an encrypted completion manifest.
3. Call `ReleaseServiceOperatorClient.preparePublisherRestore()`. The API checks global suspension, local suspension, exact DID confirmation, and manifest decryption before clearing the shard.
4. Apply pages in ascending order with `ReleaseServiceOperatorClient.restorePublisher()`.
5. Continue until `complete` is true.
6. Confirm the restored publisher remains suspended.
7. Confirm delegation is `reauthorization_required` with no retained ciphertext.
8. Review every restored nonterminal intent. Restore changes it to `failed` with `SHARD_RESTORED_REVIEW_REQUIRED`.
9. Ask the publisher to reauthorize and re-enable each workload policy explicitly.
10. Reconcile any release that may have reached the PDS before the shard was lost.
11. Remove publisher suspension only after reauthorization and reconciliation complete.

If a missing or corrupt page prevents completion, call `ReleaseServiceOperatorClient.abortPublisherRestore()` with the same publisher DID and archive ID. The operation marks the active restore as aborted and leaves the publisher suspended. A later `preparePublisherRestore()` call clears the abandoned partial state before starting another restore attempt. A completed restore cannot be aborted.

Archive audit pages remain in R2. Restore begins a new shard audit history with `publisher-restore-prepared`, `publisher-restore-started`, per-intent restore events, and `publisher-restore-completed`.

## Incident runbooks

### Compromised Access operator identity

1. Remove the identity from every Access policy.
2. Rotate the affected Access application credentials and review Access logs.
3. Pause publication when the identity could reach an admin audience.
4. Review service-control and publisher audit events for the operator subject.
5. Revoke publisher authority changed by the identity unless each action can be independently validated.

### Publisher-requested revocation

1. Revoke publisher authority from the operator console.
2. Confirm delegation status is `revoked` and encrypted session state is empty.
3. Confirm publisher application sessions were invalidated.
4. Keep listing and moderation state unchanged; revocation controls future publication authority only.

### Authorization-server or PDS outage

1. Pause admission when new authorization or refresh requests fail broadly.
2. Pause publication when refresh or PDS writes cannot be distinguished from partial completion.
3. Do not replace the exact delegated scope with `transition:generic` or another broad permission.
4. Resume after the provider succeeds and retained sessions pass refresh verification.

### Ambiguous PDS write

1. Keep the intent in `reconciling`.
2. Query the deterministic release record key directly from the publisher PDS.
3. Accept the exact expected record as published.
4. Retry only after confirmed absence and a fresh publication permit.
5. Mark a different record at the deterministic key as `conflict`.

### Workflow loss or prolonged retry

1. Inspect the authoritative publisher intent state.
2. Restart only `ready` or `reconciling` intents through the operator reconciliation operation.
3. Do not reconstruct authority from Workflow state.
4. Archive the publisher shard before destructive recovery.

### Verifier failure

1. Pause admission when verifier failures affect unrelated publishers.
2. Keep failed verification terminal for the supplied input.
3. Verify the service binding and verifier egress policy.
4. Resume only after substituted artifact, provenance, source, builder, and commit cases still fail closed.

### Durable Object schema initialization failure

1. Pause admission and publication.
2. Preserve the failing Worker version and structured error evidence.
3. Do not edit Durable Object SQLite directly.
4. Roll back the Worker when the previous version accepts the existing initial schema.
5. For a lost or corrupt publisher shard, use encrypted archive preparation and restore.

### Passkey compromise or counter anomaly

1. Revoke the credential from the approver account.
2. Invalidate outstanding approval challenges.
3. Review decisions made with the credential ID.
4. Require a new user-verified credential. Never reset a decreasing signature counter.

### Hosted-service rollback

1. Pause admission and publication.
2. Roll back to an application version compatible with the current Durable Object schema and encryption profile.
3. Keep new encryption keys available while any ciphertext uses them.
4. Run readiness, key verification, archive, and reconciliation checks before resuming.

## Alerts

`OPERATIONS_METRICS` writes privacy-safe Analytics Engine points with this layout:

| Position  | Value                               |
| --------- | ----------------------------------- |
| `index1`  | Publisher/workload hash or `global` |
| `blob1`   | Event name                          |
| `blob2`   | Outcome or error code               |
| `blob3`   | Scope                               |
| `blob4`   | Request ID                          |
| `double1` | Event value, normally `1`           |
| `double2` | Unix time in milliseconds           |

Configure alert queries for these event names:

| Event                     | Required response                                               |
| ------------------------- | --------------------------------------------------------------- |
| `publication_paused`      | Confirm the incident owner and reason immediately               |
| `refresh_failure`         | Check authorization-server health and retained key availability |
| `reconciliation_required` | Monitor backlog age and deterministic PDS outcomes              |
| `verifier_failure`        | Check verifier availability and failure-code distribution       |
| `access_denied`           | Investigate spikes by audience and request path logs            |
| `archive_gap`             | Resume the failed archive page and verify the manifest          |
| `restore_failure`         | Keep the publisher suspended and inspect archive/page ordering  |
| `configuration_failure`   | Keep readiness failed and correct variables or secrets          |
| `directory_failure`       | Retry authorization so registration completes before authority  |
| `intent_rate_limited`     | Review workload, repository, and publisher abuse patterns       |

Alert delivery is deployment-specific. A production launch requires tested notification routing and an on-call owner for every event above.

## Conformance after deployment

Run the same G0 create-only, blob-upload, refresh, and revocation probes against npmX and Cirrus. Then run the service conformance suite against the hosted and self-hosted origins. Deployment is not complete until both origins publish the same blob-only fixture, the source URLs are absent from its artifact descriptors, and a clean installer independently verifies and installs it.
