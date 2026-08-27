---
"@emdash-cms/registry-client": minor
"@emdash-cms/plugin-cli": minor
---

Adds typed clients for the experimental delegated release service. `ReleaseServiceClient` submits, polls, and cancels GitHub OpenID Connect release intents, and manages publisher workload policies and retained delegation through a publisher session. `ReleaseServiceOperatorClient` exposes the Cloudflare Access status, pause, suspension, revocation, cancellation, and reconciliation operations.

Both clients validate response envelopes and return stable `ReleaseServiceError` codes with retry metadata. Mutation helpers require idempotency keys, and workload polling requests a fresh token from the configured provider for each call.

The plugin CLI adds `emdash-plugin release submit`, `release status`, and `release cancel` for GitHub Actions jobs. The commands request audience-bound OIDC tokens from the runner, support JSON output, and use the GitHub run identity as the default idempotency key.
