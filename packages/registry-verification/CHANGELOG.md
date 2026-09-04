# @emdash-cms/registry-verification

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
