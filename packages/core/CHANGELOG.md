# emdash

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- Updated dependencies [[`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4)]:
  - @emdash-cms/admin@0.1.0
  - @emdash-cms/auth@0.1.0
  - @emdash-cms/gutenberg-to-portable-text@0.1.0

## 0.0.3

### Patch Changes

- [#8](https://github.com/emdash-cms/emdash/pull/8) [`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix crash on fresh deployments when the first request hits a public page before setup has run. The middleware now detects an empty database and redirects to the setup wizard instead of letting template helpers query missing tables.

- Updated dependencies [[`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214)]:
  - @emdash-cms/admin@0.0.2

## 0.0.2

### Patch Changes

- [#2](https://github.com/emdash-cms/emdash/pull/2) [`b09bfd5`](https://github.com/emdash-cms/emdash/commit/b09bfd51cece5e88fe8314668a591ab11de36b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix virtual module resolution errors when emdash is installed from npm on Cloudflare. The esbuild dependency pre-bundler was encountering `virtual:emdash/*` imports while crawling dist files and failing to resolve them. These are now excluded from the optimizeDeps scan.
