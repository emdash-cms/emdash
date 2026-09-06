# @emdash-cms/registry-verification

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
