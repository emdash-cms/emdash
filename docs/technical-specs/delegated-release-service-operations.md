# Delegated release service operations

This runbook covers self-host deployment, routine maintenance, and incident recovery for the delegated release service. The service is experimental and must not be deployed until the complete implementation stack and conformance gates have been accepted.

## Operational invariants

- Publisher and approver Durable Objects are authoritative for retained authority and decisions.
- The identity directory is a non-authoritative projection split across 256 Durable Objects. Deleting it does not change authority, release state, or approval state.
- The initial deployment does not use D1. The operator console performs direct DID lookup and uses the sharded identity directory for fleet maintenance.
- R2 snapshot pages are encrypted before storage. Audit export objects contain only the sanitized `audit_events.public_payload` contract.
- Restore requires a suspended publisher and a complete, decryptable archive manifest.
- Restore clears retained OAuth authority, disables workload policies, and converts nonterminal intents to `failed`. A publisher must reauthorize before publication resumes.
- Operators use supported Access routes and clients. Runbooks never require direct Durable Object SQLite edits.

## Cloudflare resources

The release-service Worker expects the following resources.

| Binding                      | Resource                         | Purpose                                                                                       |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `PUBLISHER_DO`               | `PublisherDurableObject`         | Per-publisher delegation, workload, intent, publication, audit, restore, and rate-limit state |
| `APPROVER_DO`                | `ApproverDurableObject`          | Per-approver sessions, passkeys, decisions, audit, and encrypted OAuth transactions           |
| `SERVICE_CONTROL_DO`         | `ServiceControlDurableObject`    | Global pause mode, publisher suspension, publication permits, and operator audit              |
| `IDENTITY_DIRECTORY_DO`      | `IdentityDirectoryDurableObject` | Non-authoritative publisher and approver inventory, sharded by DID hash                       |
| `RELEASE_INTENT_WORKFLOW`    | Workflow                         | Verification, approval wait, publication, and reconciliation                                  |
| `PUBLISHER_ARCHIVE_WORKFLOW` | Workflow                         | Bounded, retryable publisher snapshot and audit export                                        |
| `RELEASE_VERIFIER`           | Service binding                  | Isolated artifact and provenance verification                                                 |
| `OPERATIONS_ARCHIVE`         | R2 bucket                        | Encrypted publisher snapshot pages and append-only sanitized audit pages                      |
| `OPERATIONS_METRICS`         | Analytics Engine dataset         | Privacy-safe operational alert events                                                         |
| `ASSETS`                     | Worker static assets             | Publisher, approver, and Access operator web surfaces                                         |

The initial Durable Object migration tag is `v1`. It contains every class and table required before the first deployment.

## Configure a self-hosted deployment

### Public origin and OAuth

Set the following non-secret variables in `apps/release-service/wrangler.jsonc`:

- `PUBLIC_ORIGIN`: the canonical HTTPS custom origin, without a trailing path;
- `DEPLOYMENT_ID`: a stable identifier that remains unchanged across deployments and key rotations;
- `OAUTH_REDIRECT_URIS`: a JSON array containing `${PUBLIC_ORIGIN}/oauth/callback`;
- `ACCESS_TEAM_DOMAIN`: the exact HTTPS issuer origin for Cloudflare Access, including a custom Access hostname when configured, without a port or path;
- `ACCESS_VIEWER_AUD`, `ACCESS_REVIEWER_AUD`, and `ACCESS_ADMIN_AUD`: the distinct Access application audiences described below.

Changing `DEPLOYMENT_ID` makes existing encryption envelopes unreadable because the deployment identifier is part of the authenticated encryption context.

### Cloudflare Access

Create Access applications whose path specificity supplies the audience required by each route family.

| Audience | Paths                                                                                        | Capability                                                                         |
| -------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Viewer   | `/admin*`, `/admin/api/status`, `/admin/api/directory`, read-only publisher and audit routes | Load the operator console and inspect state                                        |
| Reviewer | `/admin/api/intents/*`                                                                       | Cancel or reconcile release intents                                                |
| Admin    | `/admin/api/pause`, `/admin/api/publishers/*`, `/admin/api/approvers/*`                      | Pause publication, suspend or revoke publishers, rotate keys, archive, and restore |

The Worker verifies the Access JWT issuer and the route-specific audience. Access group claims do not grant a role inside the Worker.

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

Create the private operations bucket before deploying the service.

```sh
pnpm exec wrangler r2 bucket create emdash-release-service-operations
```

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

After deployment, `GET /health` must return `200` without loading configuration. `GET /ready` must return `200` only after configuration and the service-control Durable Object initialize successfully.

## Operations directory

Successful publisher and approver OAuth callbacks register the DID in one of 256 directory Durable Objects. Directory registration failure emits `directory_failure` but does not block OAuth or create authority.

The operator console skips empty partitions when listing publishers or approvers. API clients can resume one partition at a time with `ReleaseServiceOperatorClient.listDirectory()`. Fleet operations must retain the returned cursor until it becomes absent.

Rebuild a missing directory as publishers and approvers complete OAuth again. Directory rows are not evidence of active delegation or approver eligibility; query each authoritative shard before acting.

## Rotate encryption keys

### Routine rotation

1. Pause publication in the operator console.
2. Add the new key version to `ENCRYPTION_KEYRING`, retain every old key, and set `current` to the new version.
3. Deploy the keyring change without removing old keys.
4. Enumerate every publisher and approver from the operations directory.
5. For each DID, run the relevant rotation operation from an empty cursor until it reports `Verified`. A compare-and-set race changes the resume cursor to a required rescan, so completion cannot discard a race reported by an earlier page.
6. Repeat a full scan from an empty cursor. Every page must report the new target version, zero races, and completion.
7. Confirm that no `refresh_failure`, `archive_gap`, or `restore_failure` event appeared during the scan.
8. Remove the retired key version from `ENCRYPTION_KEYRING` and deploy the reduced keyring.
9. Run another full verification scan. Missing retained key material must fail with `ENCRYPTION_OPERATION_FAILED`.
10. Restore the previous service mode.

Rotation decrypts and re-encrypts outside the Durable Object storage transaction. Each replacement uses a ciphertext compare-and-set, so concurrent refresh or OAuth completion wins safely and appears as a race that requires another scan.

### Compromised encryption key

1. Pause publication immediately.
2. Revoke affected publisher delegation when retained state cannot be trusted.
3. Activate a new encryption key while retaining the compromised key only for the bounded rotation window.
4. Rotate and verify every directory entry.
5. Remove the compromised key after a complete zero-race verification pass.
6. Require reauthorization for every publisher whose ciphertext could not be proved readable and authentic.

## Archive publisher shards

Use `Start archive workflow` in the operator console or `ReleaseServiceOperatorClient.startPublisherArchive()`. The Workflow writes bounded pages in this order:

1. sanitized publisher and delegation metadata;
2. disabled-capable workload policy records;
3. canonical intent rows;
4. sanitized audit events;
5. an encrypted completion manifest.

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
3. Do not replace exact create-only scope with a broader permission.
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
| `directory_failure`       | Repair projection registration without changing authority       |
| `intent_rate_limited`     | Review workload, repository, and publisher abuse patterns       |

Alert delivery is deployment-specific. A production launch requires tested notification routing and an on-call owner for every event above.

## Conformance after deployment

Run the same G0 create-only, refresh, and revocation probes against npmX and Cirrus. Then run the service conformance suite against the hosted and self-hosted origins. Deployment is not complete until both origins publish the same fixture and a clean installer independently verifies and installs it.
