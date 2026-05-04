# create-emdash

## 0.9.0

### Minor Changes

- [#859](https://github.com/emdash-cms/emdash/pull/859) [`3015280`](https://github.com/emdash-cms/emdash/commit/301528075e1ca7b96589a6eed31a97d9cdfbb7f7) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Adds non-interactive mode to `create-emdash` for CI / scripted scaffolding (#711). Pass `--template`, `--platform`, `--pm`, `--install`/`--no-install`, `--yes`, and `--force` to skip prompts; partial flag use only prompts for unset fields. Interactive flow is unchanged when no flags are supplied.
  - `--template <key>` accepts a bare template (`blog | starter | marketing | portfolio`) or the combined form `<platform>:<key>` (e.g. `cloudflare:blog`).
  - `--pm <key>` (alias `--package-manager`) selects the package manager.
  - `--yes` / `-y` accepts defaults for any unset field (cloudflare, blog, detected pm, `my-site` for an unset name).
  - `--force` is required alongside `--yes` to overwrite a non-empty target directory; without it, the CLI refuses rather than silently clobbering files.
  - `--help` / `-h` prints usage. Unknown flags fail loudly so typos don't silently drop into interactive mode.
  - An extra positional argument (e.g. `npm create emdash my blog` with a space instead of a hyphen) is now rejected as a likely typo.

  No new dependencies — built on `node:util`'s `parseArgs`.

- [#811](https://github.com/emdash-cms/emdash/pull/811) [`cee403d`](https://github.com/emdash-cms/emdash/commit/cee403d5c008feb9ca60bb7201e151b828737743) Thanks [@ascorbic](https://github.com/ascorbic)! - Scaffolds a fresh `EMDASH_ENCRYPTION_KEY` into `.dev.vars` (Cloudflare
  templates) or `.env` (Node templates) on project creation, and ensures the
  file is gitignored. Idempotent — won't overwrite an existing key on re-runs.

### Patch Changes

- [#852](https://github.com/emdash-cms/emdash/pull/852) [`e73bb5f`](https://github.com/emdash-cms/emdash/commit/e73bb5f3b54195ad6fdb327be79bddbbf25d0f17) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Removes the "Blank" template from the `npm create emdash` picker. The minimal-content template is `starter`; the previously listed `blank` only existed for the Node.js path (never Cloudflare) and was confusing. Pick `Starter` for a minimal site on either platform.

- [#869](https://github.com/emdash-cms/emdash/pull/869) [`a8bac5d`](https://github.com/emdash-cms/emdash/commit/a8bac5d7216e185b1bd9a2aaaeaa9a0306ab066e) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes autosave validation errors on content seeded from the blog,
  portfolio, and starter templates (issue #867).

  Two related issues:
  - `_key` was strictly required on Portable Text blocks by the
    generated Zod schema, but the rest of the block schema is
    `.passthrough()` and the editor regenerates `_key` on every change,
    so requiring it on input rejected legitimate seed/import data
    without protecting any real invariant. `_key` is now optional in the
    validator.
  - The portfolio template shipped `featured_image` as bare URL strings.
    `image` fields validate as `{ id, ... }` objects, so any user who
    edited a different field on a portfolio entry hit
    `featured_image: expected object, received string`. The portfolio
    seeds now use `$media` references in the same shape as the blog
    template, and every shipped template seed has stable `_key`s on its
    Portable Text nodes.

  A regression test runs every shipped template seed through the same
  validator the autosave endpoint uses, so future template changes that
  break this invariant fail before release.

## 0.8.0

### Minor Changes

- [#785](https://github.com/emdash-cms/emdash/pull/785) [`e0dd616`](https://github.com/emdash-cms/emdash/commit/e0dd61680674d111814df9033e44d500b65c9562) Thanks [@MattieTK](https://github.com/MattieTK)! - Adds support for positional directory argument, allowing `npm create emdash .` to scaffold into the current directory and `npm create emdash my-project` to skip the interactive name prompt.

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

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
