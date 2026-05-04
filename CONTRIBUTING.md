# Contributing to EmDash

> **Beta.** EmDash is published to npm. During development you work inside the monorepo — packages use `workspace:*` links, so everything "just works" without publishing.

## Prerequisites

- **Node.js** 22+
- **pnpm** 10+ (`corepack enable` if you don't have it)
- **Git**

## Quick Setup

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build          # build all packages (required before first run)
```

### Run the Demo

The `demos/simple/` app is the primary development target. It uses Node.js + SQLite — no Cloudflare account needed.

```bash
cd demos/simple
pnpm dev    # http://localhost:4321
```

Open the admin at `http://localhost:4321/_emdash/admin`. The setup wizard runs automatically on first launch — it creates the database, runs migrations, and prompts you to create an admin account.

In dev mode, you can skip passkey auth with the dev bypass:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

To populate the demo with sample content:

```bash
pnpm seed
```

### Run with Cloudflare (optional)

`demos/cloudflare/` runs on the real `workerd` runtime with D1. See its [README](demos/cloudflare/README.md) for setup.

### Developing Templates

Templates in `templates/` are workspace members and can be run directly:

```bash
cd templates/portfolio
pnpm bootstrap   # first time — set up database and seed content
pnpm dev         # run dev server
```

Available templates: `blog`, `portfolio`, `marketing`.

To start fresh, delete the database and re-bootstrap:

```bash
rm templates/portfolio/data.db
cd templates/portfolio && pnpm bootstrap
```

## Repository Layout

This is a pnpm monorepo. Here's what each directory is for:

| Directory                 | What it is                                                                                    | When you'd work here           |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| `packages/core/`          | The main `emdash` package — Astro integration, REST API, database, schema management, plugins | Most core development          |
| `packages/admin/`         | React SPA for the admin UI (`@emdash-cms/admin`)                                              | Admin UI changes, translations |
| `packages/auth/`          | Authentication — passkeys, OAuth, magic links (`@emdash-cms/auth`)                            | Auth flow changes              |
| `packages/cloudflare/`    | Cloudflare Workers adapter + plugin sandbox (`@emdash-cms/cloudflare`)                        | Cloudflare-specific features   |
| `packages/blocks/`        | Portable Text block definitions (`@emdash-cms/blocks`)                                        | Content block types            |
| `packages/create-emdash/` | `create-emdash` CLI scaffolder                                                                | Project scaffolding            |
| `packages/plugins/`       | First-party plugins (each subdirectory is a package)                                          | Plugin development             |
| `demos/simple/`           | Primary dev/test app (Node.js + SQLite)                                                       | Running and testing locally    |
| `demos/cloudflare/`       | Cloudflare Workers demo (D1)                                                                  | Testing on CF runtime          |
| `templates/`              | Starter templates (blog, portfolio, marketing + CF variants)                                  | Template development           |
| `docs/`                   | Documentation site (Starlight)                                                                | Docs changes                   |
| `e2e/`                    | Playwright test fixtures                                                                      | E2E test infrastructure        |
| `i18n/`                   | Translation status dashboard (Lunaria)                                                        | Translation tracking           |

## Development Workflow

### Watch Mode

For iterating on core packages alongside the demo, run two terminals:

```bash
# Terminal 1 — rebuild packages/core on change
cd packages/core && pnpm dev

# Terminal 2 — run the demo
cd demos/simple && pnpm dev
```

Changes to `packages/core/src/` will be picked up by the demo's dev server automatically.

### Checks

Run these from the repo root before committing:

```bash
pnpm typecheck    # TypeScript (packages)
pnpm lint         # full type-aware lint
pnpm format       # auto-format with oxfmt (tabs, not spaces)
```

Type checking **must** pass. Lint **must** pass. Don't commit with known failures.

### Tests

```bash
pnpm test                                    # all packages
cd packages/core && pnpm test                # core only
cd packages/core && pnpm test --watch        # watch mode
pnpm test:e2e                                # Playwright (starts its own server)
```

Tests use real in-memory SQLite — no mocking. Each test gets a fresh database.

### Building Your Own Site (Inside the Monorepo)

Copy a template into `demos/`, give it a unique `name` in `package.json`, run `pnpm install`, and start developing:

```bash
cp -r templates/blog demos/my-site
# edit demos/my-site/package.json to set a unique name
pnpm install
cd demos/my-site && pnpm dev
```

Your site uses `workspace:*` links to the local packages, so core changes are reflected immediately (with watch mode).

## Key Architectural Concepts

- **Schema lives in the database**, not in code. `_emdash_collections` and `_emdash_fields` are the source of truth.
- **Real SQL tables** per collection (`ec_posts`, `ec_products`), not EAV.
- **Kysely** for all queries. Never interpolate into SQL — see `AGENTS.md` for the full rules.
- **Handler layer** (`api/handlers/*.ts`) holds business logic. Route files are thin wrappers.
- **Middleware chain**: runtime init → setup check → auth → request context.

## Adding a Migration

1. Create `packages/core/src/database/migrations/NNN_description.ts` (zero-padded sequence number).
2. Export `up(db)` and `down(db)` functions.
3. **Register it** in `packages/core/src/database/migrations/runner.ts` — migrations are statically imported, not auto-discovered (Workers bundler compatibility).

## Adding an API Route

1. Create the file in `packages/core/src/astro/routes/api/`.
2. Start with `export const prerender = false;`.
3. Use `apiError()`, `handleError()`, `parseBody()` from `#api/`.
4. Check authorization with `requirePerm()` on all state-changing routes.
5. Register the route in `packages/core/src/astro/integration/routes.ts`.

## Internationalization (i18n)

The admin UI is translatable using [Lingui](https://lingui.dev). All user-visible strings in `packages/admin/src/` should be wrapped for translation.

### Making strings translatable

Use the `t` tagged template for plain strings and `<Trans>` for strings containing JSX:

```tsx
import { Trans, useLingui } from "@lingui/react/macro";

function MyComponent() {
	const { t } = useLingui();

	return (
		<div>
			{/* Plain strings */}
			<h1>{t`Settings`}</h1>
			<label>{t`Email address`}</label>

			{/* Strings with interpolation */}
			<p>{t`Authentication error: ${error}`}</p>

			{/* Strings containing JSX elements */}
			<p>
				<Trans>
					Don't have an account? <a href="/signup">Sign up</a>
				</Trans>
			</p>
		</div>
	);
}
```

**Don't include `messages.po` changes in feature or bugfix PRs.** A workflow runs `pnpm locale:extract` on merge to `main` and commits the catalog updates automatically. Including extracted PO changes in a non-translation PR creates churn and merge conflicts, since the line-number references in the catalogs shift on every edit. If you ran extraction locally and ended up with `.po` changes, revert them before opening the PR.

Translation PRs are the exception — see [Translating EmDash](https://docs.emdashcms.com/contributing/translating/).

### What to wrap

- Button labels, headings, descriptions, error messages, placeholder text — anything a user reads.
- Don't wrap: log messages, developer-facing errors, HTML attributes that aren't user-visible, or strings that are the same in every language (brand names, URLs). Do wrap `aria-label` when it labels an interactive control, because screen readers announce it to users. For decorative elements, avoid `aria-label` and use `aria-hidden="true"` instead.

For the full translation contributor guide, see [Translating EmDash](https://docs.emdashcms.com/contributing/translating/).

## Contribution Policy

### What we accept

| Type             | Process                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Bug fixes**    | Open a PR directly. Include a failing test that reproduces the bug.                                                             |
| **Docs / typos** | Open a PR directly.                                                                                                             |
| **Translations** | Open a PR directly. See [Translating EmDash](https://docs.emdashcms.com/contributing/translating/).                             |
| **Features**     | Open a [Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) and wait for a maintainer to approve it. |
| **Refactors**    | Open a Discussion first. Refactors are opinionated and need alignment.                                                          |
| **Performance**  | Open a Discussion first with benchmarks showing the improvement.                                                                |

**Feature PRs without prior maintainer approval will be closed.** This isn't about gatekeeping — it's about not wasting your time on work that might not align with the project's direction. Open a Discussion, let us talk it through, and wait for a maintainer to give the go-ahead before writing code.

### AI-generated PRs

We welcome AI-assisted contributions. They are held to the same quality bar as any other PR:

- The submitter is responsible for the code's correctness, not the AI tool.
- AI-generated PRs must pass all CI checks, follow the project's code patterns, and include tests.
- The PR template has an AI disclosure checkbox — please check it and name the model/tool you used (e.g. Claude Opus 4.7, GPT-5.5, Cursor + Sonnet 4.6). This isn't punitive; it helps reviewers pay extra attention to edge cases that AI tools commonly miss, and lets them run the review pass with a different model family — different families have different blind spots.
- Bulk/spray PRs across the repo (e.g., "fix all lint warnings", "add types everywhere") will be closed. If you see a pattern worth fixing, open a Discussion first.

### What we don't accept

- **Drive-by feature additions.** If there's no Discussion, there's no PR.
- **Speculative refactors** that don't solve a concrete problem.
- **Dependency upgrades** outside of Renovate/Dependabot. We manage these centrally.
- **"Improvements"** to code you haven't been asked to change (added logging, extra error handling, style changes in unrelated files).

## Changesets

Every PR that changes the behavior of a published package needs a **changeset** — a small Markdown file that describes the change for the CHANGELOG and determines the version bump. Without a changeset, the change won't trigger a package release.

### When you need one

- Bug fixes, features, refactors, or any other change that affects a published package's behavior or API.
- Changes that span multiple packages need one changeset listing all affected packages.
- If a PR makes more than one distinct change, add a separate changeset for each. Each one becomes its own CHANGELOG entry.

### When you don't

- Docs-only changes, test-only changes, CI/tooling changes, or changes to demo apps and templates (these are in the changeset ignore list).

### How to add one

Run from the repo root:

```bash
pnpm changeset
```

This walks you through selecting the affected package(s), the semver bump type, and a description. It creates a randomly-named `.md` file in `.changeset/`.

You can also create one manually — see the existing files in `.changeset/` for the format.

### Writing the description

Start with a present-tense verb describing what the change does, as if completing "This PR...":

- **Adds** — a new feature or capability
- **Fixes** — a bug fix
- **Updates** — an enhancement to existing behavior
- **Removes** — removed functionality
- **Refactors** — internal restructuring with no behavior change

Focus on how the change affects someone **using** the package, not implementation details. The description ends up in the CHANGELOG, which people read once during upgrades.

**Patch** (bug fixes, refactors, small improvements):

```markdown
---
"emdash": patch
---

Fixes CLI `--json` flag so JSON output is clean. Log messages now go to stderr when `--json` is set.
```

**Minor** (new features, non-breaking additions):

```markdown
---
"emdash": minor
---

Adds `scheduled_at` field to content entries, enabling scheduled publishing via the admin UI.
```

**Major** (breaking changes) — include migration guidance:

```markdown
---
"emdash": major
---

Removes the `legacyAuth` option from the integration config. All sites must use passkey authentication.

To migrate, remove `legacyAuth: true` from your `emdash()` config in `astro.config.mjs`.
```

### Which packages?

Only published packages need changesets. Demos, templates, docs, and test fixtures are excluded. The main packages are:

- `emdash` (core)
- `@emdash-cms/admin`, `@emdash-cms/auth`, `@emdash-cms/cloudflare`, `@emdash-cms/blocks`
- `create-emdash`
- First-party plugins (`@emdash-cms/plugin-*`)

When in doubt, run `pnpm changeset` and it will only show packages that aren't ignored.

## Commits and PRs

- Branch from `main`.
- Commit messages: describe _why_, not just _what_.
- Fill out the PR template completely. PRs with an empty template will be closed.
- Ensure `pnpm typecheck` and `pnpm lint` pass before pushing.
- Run relevant tests.

## Getting Help

- Read `AGENTS.md` for architecture and code patterns
- Check the [documentation site](https://docs.emdashcms.com) for guides and API reference
- Open an issue or ask in the chat
