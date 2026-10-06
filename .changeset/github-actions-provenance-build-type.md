---
"emdash": patch
"@emdash-cms/registry-verification": patch
---

Fixes installing and updating registry plugins whose releases were attested with `actions/attest-build-provenance` v3, including releases from the workflow that `emdash-plugin release setup` generates. These installs previously failed with "release provenance could not be verified". Provenance in both GitHub formats is now accepted, and releases built on self-hosted runners are still rejected.
