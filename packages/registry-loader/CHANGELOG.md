# @emdash-cms/registry-loader

## 0.1.2

### Patch Changes

- [#3548](https://github.com/emdash-cms/emdash/pull/3548) [`7541959`](https://github.com/emdash-cms/emdash/commit/7541959ff8b38a906eb928277d59d451a0b4cbbf) Thanks [@swissky](https://github.com/swissky)! - Adds an `includeLatestRelease` option to the collection filter, for example `getLiveCollection("plugins", { limit: 20, includeLatestRelease: true })`. Each entry then also carries its package's latest release as `latestRelease`, the same data `getLiveEntry` returns, so a listing can show release artifacts such as icons. It costs one extra registry request per package that has a published release. An entry whose release can't be loaded within 3 seconds is returned without it, and failures other than a missing release are logged as warnings.

## 0.1.1

### Patch Changes

- Updated dependencies [[`895fb69`](https://github.com/emdash-cms/emdash/commit/895fb699223f27a26a1556c9d009e71019cece13)]:
  - @emdash-cms/registry-client@0.7.0

## 0.1.0

### Minor Changes

- [#3120](https://github.com/emdash-cms/emdash/pull/3120) [`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `registryLoader()` for reading the moderated EmDash plugin registry through Astro live content collections. Collection loads support free-text and exact publisher/package searches, capability filters, and limits. Single-entry loads resolve a publisher handle or DID and include the latest visible release when one exists.
  
  Registry searches recognize exact handles, DIDs, and identity/slug pairs. Package views include the publisher's current verified handle when available.

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/registry-client@0.6.1
