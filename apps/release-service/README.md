# EmDash delegated release service

This Cloudflare Worker publishes verified EmDash plugin releases from approved GitHub Actions workflows. It keeps publisher-owned package metadata and release records in the publisher's [Atmosphere account](https://docs.emdashcms.com/plugins/creating-plugins/publishing/#your-atmosphere-account) while removing the need to store an AT Protocol credential in GitHub.

The hosted service runs at [releases.emdashcms.com](https://releases.emdashcms.com). The service is experimental. Publishers should follow [Automated plugin releases](https://docs.emdashcms.com/plugins/creating-plugins/delegated-releases/). This README covers the service boundary, contributor workflow, and deployment resources.

## User surfaces

The Worker serves three separate interfaces:

| Path                                    | User                            | Authentication                                                      | Purpose                                                                                                                                    |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/publisher`                            | Plugin publisher                | Atmosphere account application session                              | Authorise release publishing, connect GitHub workflows, review release state, and revoke publishing.                                       |
| `/approver` and `/approvals/{intentId}` | Profile-listed release approver | Atmosphere account application session plus a user-verified passkey | Enrol passkeys and approve or reject checksum-bound releases.                                                                              |
| `/admin`                                | Service operator                | Cloudflare Access                                                   | Pause the service, inspect publisher and approver state, reconcile intents, rotate encryption keys, and run archive or restore operations. |

The publisher and approver interfaces use the same Atmosphere account identity and sign-in language. Operator access is a separate administrative boundary and is not linked from the publisher interface.

## Publication flow

The service processes an automated release in this order:

1. The publisher authorises the exact create-only release and blob OAuth scope.
2. A GitHub Actions job presents a one-time invitation and a GitHub OIDC token.
3. The publisher checks the repository, workflow file, ref, and environment before confirming the connection.
4. The service verifies the signed package profile and its canonical repository before storing the workflow policy.
5. Every workflow run presents a fresh GitHub OIDC token. The service compares its repository, owner, workflow, ref, environment, commit, run, and runner claims with the stored policy.
6. The Action uploads the bundle and raw Sigstore provenance to private R2 staging. Profile and workflow checks happen before these uploads.
7. `ReleaseIntentWorkflow` verifies the profile revision, release-key absence, artifact bytes, bundle manifest, declared access, GitHub provenance, and approval policy.
8. A release that expands declared access or uses `confirmation: always` waits for a profile-listed approver's passkey decision.
9. The service uploads verified files to the publisher's PDS and creates the release record with its exact delegated OAuth session.
10. The service retains verified provenance at a checksum-addressed public route and removes transient staging objects.

An ambiguous PDS create enters reconciliation. The Workflow reads the deterministic release key and accepts only the exact expected record as published.

## Authority boundaries

The service keeps each identity and credential separate.

| Authority                     | Stored where                          | Permitted operations                                                                                                                               |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher application session | `PublisherDurableObject`              | Browser access to that publisher's dashboard and workflow-connection decisions.                                                                    |
| Publisher release delegation  | Encrypted in `PublisherDurableObject` | Create package release records and upload package or image blobs. It cannot edit profiles, update or delete releases, or write another collection. |
| GitHub OIDC token             | Not retained                          | Authenticate one workflow request and bind it to GitHub claims. It cannot call the publisher's PDS.                                                |
| Approver application session  | `ApproverDurableObject`               | Browser access to that approver's passkeys and eligible release decisions.                                                                         |
| Passkey credential            | `ApproverDurableObject`               | User-verified approval or rejection of one verification digest.                                                                                    |
| Access identity               | Verified per operator request         | Reach the viewer, reviewer, or admin operator routes allowed by the Access audience.                                                               |

Package-profile writes remain in `emdash-plugin profile setup`, which uses the publisher's local CLI OAuth session. The service returns `PACKAGE_PROFILE_REQUIRED` before workflow confirmation or artifact upload when the profile is absent, lacks delegated-release settings, uses a non-canonical repository URL, or names another repository.

## Cloudflare resources

`wrangler.jsonc` defines the complete initial resource set.

| Binding                            | Resource                           | Role                                                                                                   |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PUBLISHER_DO`                     | Publisher Durable Object           | Delegation, workflow policy, release intents, publication state, audit, and per-publisher rate limits. |
| `APPROVER_DO`                      | Approver Durable Object            | Sessions, passkeys, challenges, decisions, and approver audit.                                         |
| `SERVICE_CONTROL_DO`               | Service-control Durable Object     | Pause mode, publisher suspension, publication permits, and operator audit.                             |
| `IDENTITY_DIRECTORY_DO`            | 256-shard Durable Object directory | Rebuildable publisher and approver inventory for fleet operations.                                     |
| `OAUTH_STATE_DO`                   | OAuth-state Durable Object         | Short-lived OAuth transaction state.                                                                   |
| `RELEASE_INTENT_WORKFLOW`          | Cloudflare Workflow                | Verification, approval wait, publication, and reconciliation.                                          |
| `PUBLISHER_ARCHIVE_WORKFLOW`       | Cloudflare Workflow                | Encrypted publisher archive creation.                                                                  |
| `ENCRYPTION_VERIFICATION_WORKFLOW` | Cloudflare Workflow                | Fleet key-rotation verification.                                                                       |
| `RELEASE_VERIFIER`                 | Worker service binding             | Isolated bundle and provenance verification.                                                           |
| `PUBLICATION_STAGING`              | Private R2 bucket                  | Transient workflow uploads and publication materialisation.                                            |
| `PROVENANCE_STORE`                 | Private R2 bucket                  | Immutable verified Sigstore bundles served through the checksum route.                                 |
| `OPERATIONS_ARCHIVE`               | Private R2 bucket                  | Encrypted archive pages and sanitised audit exports.                                                   |
| `OPERATIONS_METRICS`               | Analytics Engine dataset           | Privacy-safe operational events.                                                                       |

Durable Objects are authoritative. The identity directory is a rebuildable projection; the service does not use D1.

## Local development

Install dependencies and build the workspace packages before the first service typecheck:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Run the Worker and static UI through the Cloudflare Vite plugin:

```sh
pnpm --filter @emdash-cms/release-service dev
```

Copy `apps/release-service/.env.example` to `apps/release-service/.env` and add local runtime secrets there. Do not add `.dev.vars`; Wrangler loads one or the other, and an existing `.dev.vars` prevents `.env` from loading. The required production secrets are `OAUTH_ASSERTION_KEYSET` and `ENCRYPTION_KEYRING`.

Run the service checks with the following commands:

```sh
pnpm --filter @emdash-cms/release-service typecheck
pnpm --filter @emdash-cms/release-service test
pnpm --filter @emdash-cms/release-service test:browser
pnpm --filter @emdash-cms/release-service build
```

`test` covers the Worker, Durable Objects, Workflows, encryption profiles, and React UI. `test:browser` starts the local Worker and runs the publisher, approver, and Access Playwright journeys.

## Deployment

Deploy `apps/release-verifier` first because the release service reaches it through the `RELEASE_VERIFIER` service binding. Create the configured Durable Object namespaces, Workflows, R2 buckets, Analytics Engine dataset, Access applications, assertion key set, and encryption keyring before deploying the service.

Use the [operations runbook](../../docs/technical-specs/delegated-release-service-operations.md) for resource creation, Access audiences, R2 lifecycle rules, deployment validation, key rotation, archive and restore, and incident recovery. The [service specification](../../docs/technical-specs/delegated-release-service.md) defines the protocol and security invariants.

## Related components

- [`apps/release-action`](../release-action/) authenticates GitHub jobs and uploads exact release inputs.
- [`apps/release-verifier`](../release-verifier/) isolates untrusted bundle and Sigstore verification.
- [`packages/plugin-cli`](../../packages/plugin-cli/) prepares package profiles and generates the default workflow.
- [`packages/registry-client`](../../packages/registry-client/) provides the release-service clients and direct-PDS readers.
