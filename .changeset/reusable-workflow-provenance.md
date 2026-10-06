---
"emdash": patch
"@emdash-cms/registry-verification": patch
---

Fixes publishing and installing registry plugins attested by a GitHub Actions reusable workflow in the same repository and ref as its calling workflow. These releases previously failed with `PROVENANCE_UNVERIFIABLE` because the caller and signer were treated as the same workflow.
