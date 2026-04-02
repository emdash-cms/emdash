# Contributing to EmDash

> **Beta.** EmDash is published to npm. During development you work inside the monorepo -- packages use `workspace:*` links, so everything "just works" without publishing.

## Prerequisites

- **Node.js** 22+
- **pnpm** 10+ (`corepack enable` if you don't have it)
- **Git**

## Quick Setup

```bash
git clone <repo-url> && cd emdash
pnpm install
pnpm build          # build all packages (required before first run)
```

### Run the Demo

The `demos/simple/` app is the primary development target. It is kept in sync with `templates/blog/` and uses Node.js + SQLite — no Cloudflare account needed.

```bash
pnpm --filter emdash-demo seed   # seed sample content
pnpm --filter emdash-demo dev    # http://localhost:4321
```

Open the admin at `http://localhost:4321/_emdash/admin`.

In dev mode, passkey auth is bypassed automatically. If you hit the login screen, visit:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

### Run with Cloudflare (optional)

`demos/cloudflare/` runs on the real `workerd` runtime with D1. See its [README](demos/cloudflare/README.md) for setup.

### Developing Templates

Templates in `templates/` are workspace members and can be run directly:

```bash
# First time: set up database and seed content
pnpm --filter @emdash-cms/template-portfolio bootstrap

# Run the dev server
pnpm --filter @emdash-cms/template-portfolio dev
```

Available templates:

| Template  | Filter Name                      |
| --------- | -------------------------------- |
| Blog      | `@emdash-cms/template-blog`      |
| Portfolio | `@emdash-cms/template-portfolio` |
| Marketing | `@emdash-cms/template-marketing` |

Edit files in `templates/{name}/src/` and changes hot reload.

**Cloudflare variants** (`*-cloudflare`) share source with their base templates via `scripts/sync-cloudflare-templates.sh`. Run that script after editing base template shared files.

Demo/template sync is handled by `scripts/sync-blog-demos.sh`:

- Full sync: `templates/blog` -> `demos/simple`
- Frontend sync (keep runtime-specific config/files):
  - `templates/blog-cloudflare` -> `demos/cloudflare`
  - `templates/blog-cloudflare` -> `demos/preview`
  - `templates/blog` -> `demos/postgres`

To start fresh, delete the database and re-bootstrap:

```bash
rm templates/portfolio/data.db
pnpm --filter @emdash-cms/template-portfolio bootstrap
```

## Development Workflow

### Watch Mode

For iterating on core packages alongside the demo, run two terminals:

```bash
# Terminal 1 — rebuild packages/core on change
pnpm --filter emdash dev

# Terminal 2 — run the demo
pnpm --filter emdash-demo dev
```

Changes to `packages/core/src/` will be picked up by the demo's dev server automatically.

### Checks

Run these before committing:

```bash
pnpm typecheck       # TypeScript (packages)
pnpm typecheck:demos # TypeScript (Astro demos)
pnpm --silent lint:quick   # fast lint (< 1s) — run often
pnpm --silent lint:json    # full type-aware lint (~10s) — run before commits
pnpm format          # auto-format with oxfmt
```

Type checking **must** pass. Lint **must** pass. Don't commit with known failures.

### Tests

```bash
pnpm test                              # all packages
pnpm --filter emdash test            # core only
pnpm --filter emdash test --watch    # watch mode
pnpm test:e2e                          # Playwright (requires demo running)
```

Tests use real in-memory SQLite — no mocking. Each test gets a fresh database.

## Repository Layout

```
emdash/
├── packages/
│   ├── core/              # emdash — the main package (Astro integration + APIs + admin)
│   ├── auth/              # @emdash-cms/auth — passkeys, OAuth, magic links
│   ├── admin/             # @emdash-cms/admin — React admin SPA
│   ├── cloudflare/        # @emdash-cms/cloudflare — CF adapter + plugin sandbox
│   ├── create-emdash/   # create-emdash — project scaffolder
│   ├── gutenberg-to-portable-text/  # WP block → Portable Text converter
│   └── plugins/           # first-party plugins (each dir = package)
├── demos/
│   ├── simple/            # emdash-demo — primary dev/test app (Node.js + SQLite)
│   ├── cloudflare/        # Cloudflare Workers demo (D1)
│   ├── plugins-demo/      # plugin development testbed
│   └── ...
├── templates/             # starter templates (blog, portfolio, marketing + cloudflare variants)
├── docs/                  # public documentation site (Starlight)
└── e2e/                   # Playwright test fixtures
```

The main package is **`packages/core`**. Most of your work will happen there.

## Building Your Own Site (Inside the Monorepo)

The easiest way to build a real site during development is to add it as a workspace member.

1. Copy `templates/blog/` (or `templates/blank/`) into `demos/`:

   ```bash
   cp -r templates/blog demos/my-site
   ```

2. Edit `demos/my-site/package.json` — set a unique `name` field.

3. Run `pnpm install` from the root to link workspace dependencies.

4. Start developing:

   ```bash
   pnpm --filter my-site dev
   ```

Your site will use `workspace:*` links to the local packages, so any changes you make to core will be reflected immediately (with watch mode).

## Key Architectural Concepts

- **Schema lives in the database**, not in code. `_emdash_collections` and `_emdash_fields` are the source of truth.
- **Real SQL tables** per collection (`ec_posts`, `ec_products`), not EAV.
- **Kysely** for all queries. Never interpolate into SQL -- see `AGENTS.md` for the full rules.
- **Handler layer** (`api/handlers/*.ts`) holds business logic. Route files are thin wrappers.
- **Middleware chain**: runtime init -> setup check -> auth -> request context.

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

## Contribution Policy

### What we accept

| Type             | Process                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Bug fixes**    | Open a PR directly. Include a failing test that reproduces the bug.                                                                  |
| **Docs / typos** | Open a PR directly.                                                                                                                  |
| **Features**     | Open a [Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) first. Wait for approval before writing code. |
| **Refactors**    | Open a Discussion first. Refactors are opinionated and need alignment.                                                               |
| **Performance**  | Open a Discussion first with benchmarks showing the improvement.                                                                     |

**PRs that add features without a prior approved Discussion will be closed.** This isn't about gatekeeping — it's about not wasting your time on work that might not align with the project's direction. Talk to us first and we'll figure out the right approach together.

### AI-generated PRs

We welcome AI-assisted contributions. They are held to the same quality bar as any other PR:

- The submitter is responsible for the code's correctness, not the AI tool.
- AI-generated PRs must pass all CI checks, follow the project's code patterns, and include tests.
- The PR template has an AI disclosure checkbox — please check it. This isn't punitive; it helps reviewers know to pay extra attention to edge cases that AI tools commonly miss.
- Bulk/spray PRs across the repo (e.g., "fix all lint warnings", "add types everywhere") will be closed. If you see a pattern worth fixing, open a Discussion first.

### What we don't accept

- **Drive-by feature additions.** If there's no Discussion, there's no PR.
- **Speculative refactors** that don't solve a concrete problem.
- **Dependency upgrades** outside of Renovate/Dependabot. We manage these centrally.
- **"Improvements"** to code you haven't been asked to change (added logging, extra error handling, style changes in unrelated files).

## Commits and PRs

- Branch from `main`.
- Commit messages: describe _why_, not just _what_.
- Fill out the PR template completely. PRs with an empty template will be closed.
- Ensure `pnpm typecheck` and `pnpm --silent lint:json` pass before pushing.
- Run relevant tests.

## What's Intentionally Missing (For Now)

These are known gaps -- don't try to fix them unless specifically asked:

- **Rate limiting** -- no brute-force protection on auth endpoints
- **Password auth** -- passkeys + magic links + OAuth only, by design
- **Plugin marketplace** -- architecture exists, runtime installation is post-beta
- **Real-time collaboration** -- planned for v1

## Getting Help

- Read `AGENTS.md` for architecture and code patterns
- Check the [documentation site](https://docs.emdashcms.com) for guides and API reference
- Open an issue or ask in the chat
