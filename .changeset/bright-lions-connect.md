---
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-client": minor
---

Adds repository-level automated plugin releases. `emdash-plugin release setup` writes one shared `.github/workflows/emdash-release.yml` at the Git repository root, including when setup runs from a nested package. The workflow resolves `<slug>@<version>` tags to a unique plugin manifest, rejects version mismatches before attestation, and requests its first repository connection through GitHub OpenID Connect without an Actions secret.

Prepare later packages with `emdash-plugin profile setup --dir <package-directory>`. Their first release reuses approved repository workflow scopes when the signed package profile names the same repository. Tag and manual-run scopes accumulate after publisher confirmation instead of replacing each other. Existing package approvals remain package-scoped until the publisher explicitly confirms a repository connection; existing generated workflows and the legacy optional connection-invitation input remain supported.
