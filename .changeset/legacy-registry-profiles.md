---
"emdash": patch
"@emdash-cms/registry-verification": patch
---

Fixes installation of the existing third-party registry packages that were published before signed repository metadata was required. Only the current signed profile revision of each affected package is accepted: a profile update must include the repository metadata, and releases with provenance still require a signed repository anchor.
