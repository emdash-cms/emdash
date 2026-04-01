# emdash

## 0.0.2

### Patch Changes

- [#2](https://github.com/emdash-cms/emdash/pull/2) [`b09bfd5`](https://github.com/emdash-cms/emdash/commit/b09bfd51cece5e88fe8314668a591ab11de36b4d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix virtual module resolution errors when emdash is installed from npm on Cloudflare. The esbuild dependency pre-bundler was encountering `virtual:emdash/*` imports while crawling dist files and failing to resolve them. These are now excluded from the optimizeDeps scan.
