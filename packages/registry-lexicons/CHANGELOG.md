# @emdash-cms/registry-lexicons

## 0.4.0

### Minor Changes

- [#2765](https://github.com/emdash-cms/emdash/pull/2765) [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates plugin publishing to host package bundles, icons, banners, and screenshots as blobs on the publisher's Personal Data Server by default. Run `emdash-plugin publish` from the plugin directory; the CLI builds the bundle, checks the stored OAuth grant, uploads the artifacts, and writes CID-bound checksums into the release record.

  Existing scripts can keep externally hosted package bundles with `emdash-plugin publish --url <https-url>`. The CLI still downloads that URL to validate and hash the served bytes. Listing images are uploaded as publisher blobs on both paths.

  The experimental aggregator release envelope replaces `mirrors` with typed `artifactCaches`. The field is optional during rolling upgrades, and updated clients treat an omitted field as an empty cache list. A record-scoped cache descriptor supplies its service endpoint; clients derive `/r/{did}/{collection}/{rkey}/{recordCid}/{blobCid}` so cache admission is bound to the exact release revision.

  Install and update verify raw cache, PDS, and external fallback bytes against the signed checksum and blob metadata. The authenticated image proxy may serve a transformed record-scoped cache rendition; if that cache is unavailable, it falls back to checksum-verified PDS or external bytes. Listing images remain capped at 1 MiB.

  Sites must upgrade EmDash before installing a release whose package artifact is available only as a PDS blob. Older EmDash versions require an external package URL.

  #### What should I do?

  Remove `--artifact-base-url` from publish scripts and stop pre-uploading listing images. The CLI rejects the removed option with migration guidance. Replace any experimental `releaseView.mirrors` access with `releaseView.artifactCaches ?? []`. If an existing granular login reports `MISSING_BLOB_SCOPE`, run `emdash-plugin logout` and log in again to grant `blob:application/gzip` and `blob:image/*`.

- [#2644](https://github.com/emdash-cms/emdash/pull/2644) [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds shared, CID-bound plugin-listing moderation contracts for reducing signed AT Protocol labels and deciding which package-profile and release revisions are eligible for display.

  The registry Lexicons add experimental public assessment and policy queries. The contracts cover publisher-controlled listing metadata and displayed media; they do not assess plugin code.

## 0.3.0

### Minor Changes

- [#2067](https://github.com/emdash-cms/emdash/pull/2067) [`07c9f21`](https://github.com/emdash-cms/emdash/commit/07c9f210db300803f49ecf2b8a18fe173e459a28) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `packageProfileExtension` lexicon and its generated types, plus a `provenance` reference field on the package release extension.

## 0.2.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

## 0.1.1

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- [#1461](https://github.com/emdash-cms/emdash/pull/1461) [`b01aa9b`](https://github.com/emdash-cms/emdash/commit/b01aa9bbb436bcec07516b499eb0516cfbe414b4) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.

## 0.1.0

### Minor Changes

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `RECORD_NSIDS` and `QUERY_NSIDS` const arrays alongside the existing `NSID` map. They enumerate the record-shaped and query-shaped lexicons in this package so consumers (e.g. tooling that builds OAuth `repo:` / `rpc:` scopes) can derive their list from the lexicon set instead of hand-rolling one that drifts.

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-lexicons`: generated TypeScript types and runtime validation schemas for the EmDash plugin registry lexicons (`com.emdashcms.experimental.*`). EXPERIMENTAL — NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.
