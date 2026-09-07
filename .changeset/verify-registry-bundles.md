---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/registry-client": minor
"@emdash-cms/registry-verification": minor
---

Adds `DirectPdsClient` for reading package profiles and releases with AT Protocol repository proofs, and updates experimental decentralized registry installs and updates to verify current signed records directly from the publisher's PDS.

#### Aggregator record integrity

Install and update reject aggregator-supplied profile or release metadata whose URI or CID does not match the publisher's signed records. The server returns `AGGREGATOR_RECORD_MISMATCH` before fetching the artifact or requesting consent.

#### Publisher identity display

The admin treats handle resolution as an advisory identity signal. It keeps the install button disabled while attempting to resolve the package DID back to a handle, then blocks installation when `resolveDidToHandle()` conclusively returns `"invalid"`. An indeterminate result caused by a network failure, unsupported DID method, or missing handle displays the publisher DID and does not block installation.

Install and update trust the publisher DID and the signed repository proofs for the profile and release records. A handle is display metadata and is not an authorization or record-integrity input.

#### Provenance and release policy

The installer applies the signed profile's release policy, independently fetches and verifies supplied Sigstore/SLSA provenance, and binds moderation labels to the exact profile or release CID. Missing required provenance and any supplied provenance that is unavailable, malformed, mismatched, or unsupported block installation and updates. Artifact checksums, archive paths, bundle limits, manifest identity, and version use the same verification rules as the registry release tooling.

The verification package also exports `inspectPackageReleaseRecords` for validating signed records and policy before artifact and provenance evidence is available.

Registry install and update consent now show the exact verified profile and release CIDs, signed publisher policy, and provenance status. Install consent uses permissions and MCP tools read from the verified bundle rather than the aggregator's record copy.

Install, update, and delegated-release verification require lowercase base32 multibase `sha2-256` multihashes for package artifacts and provenance documents. The plugin CLI already produces this format. The authenticated image-artifact proxy still accepts legacy bare hexadecimal SHA-256 checksums for display-only images.
