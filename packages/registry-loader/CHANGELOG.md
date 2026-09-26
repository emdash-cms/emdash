# @emdash-cms/registry-loader

## 0.1.0

### Minor Changes

- [#3120](https://github.com/emdash-cms/emdash/pull/3120) [`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `registryLoader()` for reading the moderated EmDash plugin registry through Astro live content collections. Collection loads support free-text and exact publisher/package searches, capability filters, and limits. Single-entry loads resolve a publisher handle or DID and include the latest visible release when one exists.
  
  Registry searches recognize exact handles, DIDs, and identity/slug pairs. Package views include the publisher's current verified handle when available.

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/registry-client@0.6.1
