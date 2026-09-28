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

`pnpm build` is required before the first typecheck in a fresh checkout. Scoped package typechecks such as `pnpm --filter @emdash-cms/plugin-cli typecheck` resolve internal workspace type declarations from `dist/`, which the build emits; this matches CI's build-then-typecheck order.

Tests use real in-memory SQLite -- no mocking. Each test gets a fresh database. Typecheck and lint must pass.

### Visual regression tests

The admin UI has a Playwright visual-regression suite (`e2e/tests/visual-regression.spec.ts`) that screenshots key screens in both LTR (English) and RTL (Arabic). It is gated behind `EMDASH_VISUAL=1` so it stays out of the default `pnpm test:e2e` run:

```bash
EMDASH_VISUAL=1 pnpm test:e2e visual-regression
```

Baselines are platform-specific. **CI (Linux) is the source of truth** -- committed baselines are `*-chromium-linux.png`. Locally generated macOS/Windows baselines (`*-darwin.png`, `*-win32.png`) are gitignored; never commit them, they won't match CI.

When a PR changes how a screen renders, the `Visual Regression` check goes red and a bot posts a sticky comment with the diff images. A maintainer reviews the diffs and, if the change is intended, comments `/accept-baselines`. The `Visual Regression — Apply` job then commits the regenerated Linux baselines to the PR branch. Baselines are never updated automatically on push -- a maintainer must accept each change.

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

### Interface screenshots

An issue that refers to the interface must include a screenshot showing the reported state. A PR that changes the UI must include screenshots of the rendered result. Include before-and-after images when the result alone does not make the change clear. Describe the behavior in text as well, and use alt text that identifies the screen and relevant state.

In the GitHub web interface, drag or paste the images into the issue or PR body. From GitHub CLI 2.99.0 or later, use the repeatable `--attach` flag with issue and PR create, edit, or comment commands. CLI `--attach` uploads require write access to the repository; web interface uploads do not.

The following command attaches two screenshots to a PR body:

```bash
gh pr create --body-file /tmp/emdash-pr.md \
	--attach './before.png#Settings screen before the change' \
	--attach './after.png#Settings screen after the change'
```

If the body contains `![Settings screen after the change](./after.png)`, pass `--attach ./after.png` to upload the image and replace the local path in place. GitHub appends attached files that are not referenced in the body. See [Attaching files with GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) for the supported formats and size limits.

### PR rules

- Branch from `main`.
- Fill out the PR template completely. **PRs with an empty or missing template will be closed automatically.** The template is loaded by the GitHub UI; if you create a PR via API/CLI, copy `.github/PULL_REQUEST_TEMPLATE.md` into the body.
- `pnpm typecheck` and `pnpm lint` must pass before pushing.
- Run relevant tests.
- Include screenshots for every UI change.
- Commit messages describe _why_, not just _what_.

## Changesets

Follow [Writing and reviewing changesets](.changeset/README.md) for when a change needs one, package bump types, the user-facing writing standard, examples, and review criteria.

Create the file with the Changesets CLI, then edit the generated Markdown:

```bash
pnpm changeset
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
- [TRIAGE.md](TRIAGE.md) -- guidance for community triagers
- [docs.emdashcms.com](https://docs.emdashcms.com) -- user guides and API reference
- [Discussions](https://github.com/emdash-cms/emdash/discussions) -- ask questions, propose features
- [Issues](https://github.com/emdash-cms/emdash/issues) -- bug reports
