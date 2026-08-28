---
"@emdash-cms/registry-client": minor
"@emdash-cms/plugin-cli": minor
---

Adds typed clients for the experimental delegated release service. `ReleaseServiceClient` submits, polls, and cancels GitHub OpenID Connect release intents; manages publisher workload policies and retained delegation; and lets publishers check whether profile-listed approvers have an active passkey and inspect publisher-scoped audit events through a publisher session. `ReleaseServiceOperatorClient` exposes the Cloudflare Access status and sanitized audit, sharded publisher and approver inventory, pause, suspension, revocation, cancellation, reconciliation, resumable encryption-key rotation, Workflow-backed fleet verification, audited key retirement, encrypted R2 archive, and fail-safe publisher restore and abort operations.

Both clients validate response envelopes and return stable `ReleaseServiceError` codes with retry metadata. Mutation helpers require idempotency keys, and workload polling requests a fresh token from the configured provider for each call.

The plugin CLI adds `emdash-plugin release dry-run`, `release submit`, `release status`, and `release cancel` for GitHub Actions jobs. Dry-run verifies workload admission without creating an intent, consuming rate budget, or reserving a version. The commands request audience-bound OIDC tokens from the runner, support JSON output, and use the GitHub run identity as the default idempotency key where a mutation occurs.

Delegated submissions use a URL-source release record: each package or listing-image artifact supplies a checksum-bound HTTPS URL and no blob. The service stages and uploads those bytes through the publisher's delegation, then creates a blob-only release record. Submit and dry-run reject mixed or blob-backed source inputs before requesting GitHub OIDC.

Interactive `release delegate`, `revoke`, `workload`, `enrol`, `approve`, and `reject` commands print validated browser handoffs. Publisher application sessions, OAuth credentials, and passkey assertions remain at the release-service origin instead of entering the terminal process.
