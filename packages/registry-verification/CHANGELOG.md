# @emdash-cms/registry-verification

## 0.3.2

### Patch Changes

- [#3248](https://github.com/emdash-cms/emdash/pull/3248) [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry plugins appearing in discovery but failing installation when their signed profiles predated repository metadata.
  
  Profiles without the optional repository extension permit releases without provenance. Manual publishing adds an available canonical HTTPS repository with optional provenance, preserves explicit profile policies on later releases, and refuses manual releases when the publisher requires provenance. EmDash routes installation verification correctly and shows site administrators actionable publisher guidance when signed records fail verification.
- Updated dependencies [[`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730), [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5), [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2), [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870), [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50), [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c), [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba), [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4), [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74), [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba), [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289), [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d)]:
  - @emdash-cms/registry-lexicons@0.6.0
  - @emdash-cms/plugin-types@0.4.0

## 0.3.1

### Patch Changes

- [#3069](https://github.com/emdash-cms/emdash/pull/3069) [`64344d3`](https://github.com/emdash-cms/emdash/commit/64344d35ebe0a5b830ba0a6d0837b30e0e0d9ccd) Thanks [@logelog](https://github.com/logelog)! - Fixes site builds on Windows failing when the plugin registry verifier is imported.
- Updated dependencies [[`befce6d`](https://github.com/emdash-cms/emdash/commit/befce6dcbbedcf2766d6540214a65f3bbb9e745a), [`4cc150e`](https://github.com/emdash-cms/emdash/commit/4cc150e931313644a96b796627e5ec74b46c0aec)]:
  - @emdash-cms/registry-lexicons@0.5.0

## 0.3.0

### Minor Changes

- [#2892](https://github.com/emdash-cms/emdash/pull/2892) [`66aeecd`](https://github.com/emdash-cms/emdash/commit/66aeecd1feded23c2ee607b799500c390a04eb92) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds interactive package-profile setup for delegated plugin releases. `emdash-plugin release setup` now creates a missing profile or adds delegated-release settings to an existing valid profile before writing the GitHub Actions workflow. Run `emdash-plugin profile setup` to prepare only the profile.

  Interactive setup asks for the GitHub repository when it is absent from `emdash-plugin.jsonc`, lets you choose when releases require approval, and confirms the profile write. Non-interactive callers must pass `--yes` when a profile change is required.

  The release service returns `PACKAGE_PROFILE_REQUIRED` before accepting artifact uploads when the signed profile is missing, lacks delegated-release settings, or names a different GitHub repository. Existing release intents also terminate with an actionable reason if their authoritative profile becomes invalid.

- [#2746](https://github.com/emdash-cms/emdash/pull/2746) [`c7b6fdf`](https://github.com/emdash-cms/emdash/commit/c7b6fdfd1f5dd9a168f5d0f6bfa9b7b9ff343145) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds optional artifact digest candidates to `GitHubProvenanceVerifier`, allowing callers that compute several supported digest algorithms in one isolated artifact fetch to verify the digest selected by a signed SLSA provenance subject.

  Existing callers can continue passing only `artifactDigest`. Successful results return the candidate that matched the signed subject.

  Fixes `@emdash-cms/registry-verification` when it is rebundled into an Astro Cloudflare application, preventing requests from failing during Worker startup.

  Adds `@emdash-cms/registry-verification/records` for Worker callers that supply an explicit `ProvenanceVerifier`. The runtime-neutral entry does not load the Node-oriented default Sigstore verifier, while the package root keeps the existing default-verifier behavior.

  Fixes `@emdash-cms/registry-verification` when it is rebundled into an Astro Cloudflare application, preventing requests from failing during Worker startup.

- [#2746](https://github.com/emdash-cms/emdash/pull/2746) [`c7b6fdf`](https://github.com/emdash-cms/emdash/commit/c7b6fdfd1f5dd9a168f5d0f6bfa9b7b9ff343145) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `DirectPdsClient` for reading package profiles and releases with AT Protocol repository proofs, and updates experimental decentralized registry installs and updates to verify current signed records directly from the publisher's PDS.

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

### Patch Changes

- [#2847](https://github.com/emdash-cms/emdash/pull/2847) [`529b28b`](https://github.com/emdash-cms/emdash/commit/529b28bd1c0e4257eaa4436721b110beb09d5ba3) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes delegated-release provenance verification so verified GitHub attestations include the repository, workflow, commit, and run identity needed to enforce an exact authorized workload.

- Updated dependencies [[`ecdba4d`](https://github.com/emdash-cms/emdash/commit/ecdba4d1338447e1a267a3498764f9a1de2a0636)]:
  - @emdash-cms/plugin-types@0.3.1

## 0.2.0

### Minor Changes

- [#2765](https://github.com/emdash-cms/emdash/pull/2765) [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

  Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

  The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

  Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

  Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

  #### What should I do?

  Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.

### Patch Changes

- Updated dependencies [[`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414), [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878)]:
  - @emdash-cms/registry-lexicons@0.4.0

## 0.1.0

### Minor Changes

- [#2067](https://github.com/emdash-cms/emdash/pull/2067) [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-verification`: runtime-neutral primitives for verifying plugin registry release artifacts. Validates multihash checksums, fetches artifacts with size and redirect guards, checks canonical tarball and bundle structure, and verifies Sigstore build provenance. Runs on both Node and workerd.

### Patch Changes

- Updated dependencies [[`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28), [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c), [`3f8b778`](https://github.com/emdash-cms/emdash/commit/3f8b77822bf8e89b065884c53c7e8b7676788c48), [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28)]:
  - @emdash-cms/registry-lexicons@0.3.0
  - @emdash-cms/plugin-types@0.3.0
