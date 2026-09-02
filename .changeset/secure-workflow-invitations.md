---
"@emdash-cms/registry-client": minor
"@emdash-cms/plugin-cli": patch
---

Adds publisher-created workflow connection invitations to delegated releases. First-time or unmatched GitHub workflows must use a package-bound, single-use invitation before they can request publisher approval; connected workflows continue without one.

Create the invitation in the publisher dashboard or with `createWorkflowConnectionInvitation()`, then save its value as the repository's `EMDASH_CONNECTION_INVITATION` GitHub Actions secret. The generated release workflow passes this secret to the release Action automatically. Custom workflows can pass `invitationToken` to `requestWorkflowConnection()`, and publishers can reject pending requests with `rejectWorkflowConnection()`.
