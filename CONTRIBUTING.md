# Contributing to EmDash

EmDash is published to npm and in active use. During development you work inside the monorepo -- packages use `workspace:*` links, so everything works without publishing.

This guide covers setup, policy, and the rules around opening a PR. For code patterns (SQL, API routes, authorization, performance, Lingui, RTL, etc.), see [AGENTS.md](AGENTS.md).

## Prerequisites

- **Node.js** 22+
- **pnpm** 10+ (`corepack enable` if you don't have it)
- **Git**

## Setup

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build   # required before first run
```

### Run the demo

`demos/simple/` is the primary development target. Node.js + SQLite, no Cloudflare account needed.

```bash
cd demos/simple
pnpm dev    # http://localhost:4321
```

Open the admin at `http://localhost:4321/_emdash/admin`. The setup wizard runs on first launch.

In dev, skip passkey auth with the dev bypass:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

Demo sites apply their `seed/seed.json` automatically on the first request when the database is empty -- there's no separate seed command.

`demos/cloudflare/` runs on the real `workerd` runtime with D1. See its [README](demos/cloudflare/README.md).

### Templates

Templates in `templates/` are workspace members and runnable directly:

```bash
cd templates/portfolio
pnpm dev
```

Available templates: `blank`, `starter`, `blog`, `portfolio`, `marketing`, plus a `-cloudflare` variant of each runnable template. Seed content is applied automatically on first request. To start fresh, delete the local database (`data.db` or the D1 binding) and restart the dev server.

### Watch mode

When iterating on `packages/core` alongside a demo, run two terminals:

```bash
# Terminal 1
cd packages/core && pnpm dev

# Terminal 2
cd demos/simple && pnpm dev
```

Core changes propagate to the demo automatically.

## Repository Layout

| Directory                 | What it is                                                                      |
| ------------------------- | ------------------------------------------------------------------------------- |
| `packages/core/`          | Main `emdash` package -- Astro integration, REST API, database, schema, plugins |
| `packages/admin/`         | React admin UI SPA (`@emdash-cms/admin`)                                        |
| `packages/auth/`          | Auth -- passkeys, OAuth, magic links (`@emdash-cms/auth`)                       |
| `packages/cloudflare/`    | Cloudflare Workers adapter + plugin sandbox                                     |
| `packages/blocks/`        | Portable Text block definitions                                                 |
| `packages/create-emdash/` | `create-emdash` CLI scaffolder                                                  |
| `packages/plugins/`       | First-party plugins                                                             |
| `demos/`                  | Dev/test apps (`simple`, `cloudflare`, `postgres`, ...)                         |
| `templates/`              | Starter templates                                                               |
| `docs/`                   | Documentation site (Starlight)                                                  |
| `e2e/`                    | Playwright test infrastructure                                                  |
| `i18n/`                   | Translation status dashboard (Lunaria)                                          |

## Checks

Run before pushing:

```bash
pnpm typecheck   # TypeScript (packages)
pnpm lint        # full type-aware lint
pnpm format      # auto-format with oxfmt (tabs)
pnpm test        # all packages
pnpm test:e2e    # Playwright
```

Tests use real in-memory SQLite -- no mocking. Each test gets a fresh database. Typecheck and lint must pass.

### Building your own site in the monorepo

Copy a template into `demos/`, give it a unique `name` in `package.json`, install, and run:

```bash
cp -r templates/blog demos/my-site
# edit demos/my-site/package.json to set a unique name
pnpm install
cd demos/my-site && pnpm dev
```

Your site uses `workspace:*` links, so core changes are reflected immediately.

## Contribution Policy

### What we accept

| Type             | Process                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Bug fixes**    | Open a PR directly. Include a failing test that reproduces the bug.                                                      |
| **Docs / typos** | Open a PR directly.                                                                                                      |
| **Translations** | Open a PR directly. See [Translating EmDash](https://docs.emdashcms.com/contributing/translating/).                      |
| **Features**     | Open a [Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) and wait for maintainer approval. |
| **Refactors**    | Open a Discussion first.                                                                                                 |
| **Performance**  | Open a Discussion first with benchmarks.                                                                                 |

**Feature PRs without prior maintainer approval will be closed.** Not gatekeeping -- it's about not wasting your time on work that might not align with the project's direction.

### What we don't accept

- **Drive-by feature additions.** No Discussion, no PR.
- **Speculative refactors** that don't solve a concrete problem.
- **Dependency upgrades** outside Renovate/Dependabot.
- **Drive-by "improvements"** in code unrelated to your change.
- **Bulk/spray PRs** ("fix all lint warnings", "add types everywhere"). Open a Discussion first.

### AI-generated PRs

AI-assisted contributions are welcome and held to the same quality bar as any other PR:

- The submitter is responsible for correctness, not the tool.
- AI-generated PRs must pass CI, follow project patterns, and include tests.
- Check the PR template's AI disclosure box and name the model/tool (e.g. Claude Opus 4.7, GPT-5.5, Cursor + Sonnet 4.6). This isn't punitive -- it helps reviewers focus on edge cases that AI tools tend to miss and run the review pass with a different model family.

### PR rules

- Branch from `main`.
- Fill out the PR template completely. **PRs with an empty or missing template will be closed automatically.** The template is loaded by the GitHub UI; if you create a PR via API/CLI, copy `.github/PULL_REQUEST_TEMPLATE.md` into the body.
- `pnpm typecheck` and `pnpm lint` must pass before pushing.
- Run relevant tests.
- Commit messages describe _why_, not just _what_.

## Changesets

Every PR that changes a published package's behavior needs a **changeset** -- a small Markdown file that describes the change for the CHANGELOG and determines the version bump. Without one, the change won't trigger a release.

### When you need one

- Bug fixes, features, refactors, or anything that affects a published package's behavior or API.
- Multi-package changes need one changeset listing all affected packages.
- A PR making multiple distinct changes can include a changeset per change -- each becomes its own CHANGELOG entry.

### When you don't

- Docs-only, test-only, CI/tooling changes, or changes to demos and templates (these are in the ignore list -- see `.changeset/config.json`).

### How

```bash
pnpm changeset
```

The CLI walks you through affected packages, bump type, and description. Edit the resulting `.md` file in `.changeset/` if needed.

### Writing the description

A changeset is the **release note a user reads while upgrading** -- it lands verbatim in the CHANGELOG. It is not a commit message, a PR description, or a summary of your diff. Don't paste your PR text into it: those explain the change to a reviewer reading the code, the changeset explains the effect to someone who will run the new version.

Write for that reader:

- Start with a present-tense verb -- **Fixes** (bug), **Adds** (feature), **Updates** (enhancement), **Removes** (removed functionality), **Refactors** (no behavior change).
- Describe the observable effect -- what's different for someone using the package.
- Leave out internal mechanics -- file names, function names, which catalog entry you bumped, how you implemented it. If a sentence only makes sense to someone who has read the diff, it doesn't belong here.
- For a breaking change, include the migration step.

One sentence is often enough.

```diff
- # too low-level -- reads like a commit message
- Align the catalog so identity-resolver's lexicons peer resolves; migrates parseCanonicalResourceUri off the result-object API in backfill.ts.
+ # right altitude -- the effect on the user
+ Fixes peer dependency warnings on install caused by mismatched `@atcute` package versions.
```

**Patch** (bug fix or small improvement):

```markdown
---
"emdash": patch
---

Fixes CLI `--json` flag so JSON output is clean. Log messages now go to stderr when `--json` is set.
```

**Minor** (new non-breaking feature):

```markdown
---
"emdash": minor
---

Adds `scheduled_at` field to content entries, enabling scheduled publishing via the admin UI.
```

**Major** (breaking change) -- include migration guidance:

```markdown
---
"emdash": major
---

Removes the `legacyAuth` option from the integration config. All sites must use passkey authentication.

To migrate, remove `legacyAuth: true` from your `emdash()` config in `astro.config.mjs`.
```

## Internationalization

The admin UI is translatable using [Lingui](https://lingui.dev). All user-visible strings in `packages/admin/src/` should be wrapped.

```tsx
import { Trans, useLingui } from "@lingui/react/macro";

function MyComponent() {
	const { t } = useLingui();
	return (
		<div>
			<h1>{t`Settings`}</h1>
			<p>{t`Authentication error: ${error}`}</p>
			<p>
				<Trans>
					Don't have an account? <a href="/signup">Sign up</a>
				</Trans>
			</p>
		</div>
	);
}
```

Wrap button labels, headings, descriptions, error messages, placeholders, and `aria-label` on interactive controls. Don't wrap log messages, developer-facing errors, brand names, or URLs. For decorative elements, prefer `aria-hidden="true"` over a translated `aria-label`.

**Don't include `messages.po` changes in feature or bugfix PRs.** A workflow runs `pnpm locale:extract` on merge to `main` and commits catalog updates automatically. Including extracted PO changes in non-translation PRs creates churn and merge conflicts because line-number references shift on every edit. If you ran extraction locally and ended up with `.po` changes, revert them before opening the PR.

Translation PRs are the exception -- see [Translating EmDash](https://docs.emdashcms.com/contributing/translating/) for the full contributor guide.

For RTL rules and the full Lingui pattern reference, see [AGENTS.md § Admin UI: Localization](AGENTS.md#admin-ui-localization-lingui).

## Getting Help

- [AGENTS.md](AGENTS.md) -- architecture and code patterns
- [docs.emdashcms.com](https://docs.emdashcms.com) -- user guides and API reference
- [Discussions](https://github.com/emdash-cms/emdash/discussions) -- ask questions, propose features
- [Issues](https://github.com/emdash-cms/emdash/issues) -- bug reports
