# create-emdash

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- [#12](https://github.com/emdash-cms/emdash/pull/12) [`9db4c2c`](https://github.com/emdash-cms/emdash/commit/9db4c2cba24d5202fba630ac366ae42cf721390f) Thanks [@ascorbic](https://github.com/ascorbic)! - Remove manual bootstrap step from CLI output

  The create-emdash CLI no longer suggests running `bootstrap` as a manual step, since EmDash now auto-bootstraps on first run.

## 0.0.4

### Patch Changes

- [#7](https://github.com/emdash-cms/emdash/pull/7) [`2022b77`](https://github.com/emdash-cms/emdash/commit/2022b773414a34de05677c776f4f4324f43a54e2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix spinner hanging during dependency installation by using async exec instead of execSync, which was blocking the event loop and preventing the spinner animation from updating.

## 0.0.3

### Patch Changes

- [#5](https://github.com/emdash-cms/emdash/pull/5) [`8e389d5`](https://github.com/emdash-cms/emdash/commit/8e389d5ef8b0a6b0577d9d7c975f048f96844185) Thanks [@ascorbic](https://github.com/ascorbic)! - Improve create-emdash CLI experience: add the EmDash branded banner, let users pick their package manager (auto-detects the one that invoked it), and ask whether to install dependencies with a spinner showing progress.

## 0.0.2

### Patch Changes

- [#3](https://github.com/emdash-cms/emdash/pull/3) [`2dc5815`](https://github.com/emdash-cms/emdash/commit/2dc5815f031459c48cfaffec84aea1ed7b9cf7fb) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix create-emdash to use all available templates from the new standalone templates repo. Templates are now selected in two steps: platform (Node.js or Cloudflare Workers) then template type (blog, starter, marketing, portfolio, blank). Downloads from `emdash-cms/templates` instead of the old monorepo path.
