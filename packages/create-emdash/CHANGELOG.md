# create-emdash

## 0.0.2

### Patch Changes

- [#3](https://github.com/emdash-cms/emdash/pull/3) [`2dc5815`](https://github.com/emdash-cms/emdash/commit/2dc5815f031459c48cfaffec84aea1ed7b9cf7fb) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix create-emdash to use all available templates from the new standalone templates repo. Templates are now selected in two steps: platform (Node.js or Cloudflare Workers) then template type (blog, starter, marketing, portfolio, blank). Downloads from `emdash-cms/templates` instead of the old monorepo path.
