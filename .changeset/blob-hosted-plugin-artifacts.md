---
"@emdash-cms/admin": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-client": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/registry-verification": minor
"emdash": minor
---

Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

#### What should I do?

Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.
