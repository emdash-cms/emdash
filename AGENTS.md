This file provides guidance to agentic coding tools working in this repository.

For human-facing contributor info (setup, repo layout, PR policy, changesets, i18n), see [CONTRIBUTING.md](CONTRIBUTING.md). This file focuses on the patterns and gotchas an agent needs to write correct code.

`CLAUDE.md` is a symlink to this file. `.opencode/skills` and `.claude/skills` are symlinks to `skills/`. Don't try to sync between them.

# Rules

**Backwards compatibility matters.** EmDash is published and in active use, pre-1.0. Prefer additive changes (new fields, new routes, new options with defaults). Breaking changes need an explicit decision, a package bump, and a changeset that calls the break out clearly. Database migrations are forward-only -- never write one that leaves existing content inaccessible. When in doubt, open a Discussion.

**TDD for bugs.** Failing test -> fix -> verify. A bug without a reproducing test is not fixed.

**Localize everything user-facing.** All admin UI strings, aria labels, and toast messages go through Lingui. All admin layout uses RTL-safe logical Tailwind classes. See [Localization](#admin-ui-localization-lingui) and [RTL](#admin-ui-rtl-safe-tailwind).

**Scope discipline.** No drive-by refactors, no bulk lint/type cleanups, no "while I'm here" edits in unrelated files. If you see a systemic issue, open a Discussion. See [CONTRIBUTING.md § Contribution Policy](CONTRIBUTING.md#contribution-policy).

## Workflow

Run `pnpm lint:json | jq '.diagnostics | length'` before starting and confirm it's clean -- if it's failing after your edits, your changes caused it.

During work:

- `pnpm lint:quick` after every edit (sub-second)
- `pnpm typecheck` (packages) or `pnpm typecheck:demos` (Astro demos) after each round of edits
- `pnpm format` regularly (oxfmt, tabs)

Before opening a PR: tests pass, lint clean, formatted, changeset added if a published package changed. See [CONTRIBUTING.md § Changesets](CONTRIBUTING.md#changesets).

A changeset is release notes a user reads while upgrading -- **not** a commit message, PR description, or summary of your diff. Do not paste your PR prose into it. Write for someone who will run the new version and wants to know what changed for them: lead with a present-tense verb (`Fixes`, `Adds`, `Updates`, `Removes`), describe the observable effect, and leave out internal mechanics (file names, refactors, how you implemented it). For a breaking change, include the migration step. One sentence is often enough.

When opening a PR with `gh`/the API, copy `.github/PULL_REQUEST_TEMPLATE.md` into the body and fill every section -- the GitHub UI injects it automatically but the CLI does not, and PRs missing it are auto-closed. Check the AI-generated code disclosure box and name the model. Tick checklist items only for what you actually verified; for test-only/docs/CI PRs, note why changeset/i18n/Discussion items are n/a.

## Architecture

EmDash is an Astro-native CMS on Cloudflare (D1 + R2 + Workers) or Node + SQLite.

- **Schema in the database.** `_emdash_collections` and `_emdash_fields` are the source of truth. Each collection gets a real SQL table (`ec_posts`, `ec_products`) with typed columns -- not EAV.
- **Middleware chain:** runtime init -> setup check -> auth -> request context (ALS). Auth middleware checks authentication only; routes check authorization.
- **Handler layer** (`packages/core/src/api/handlers/*.ts`) holds business logic and returns `ApiResult<T>` (`{ success: true, data } | { success: false, error: { code, message, details? } }`). Route files are thin wrappers.
- **Storage abstraction:** `Storage` interface with `upload/download/delete/exists/list/getSignedUploadUrl`. `LocalStorage` for dev, `S3Storage` for R2/AWS. Access via `emdash.storage` from locals.

Key files:

| File                                              | Purpose                                               |
| ------------------------------------------------- | ----------------------------------------------------- |
| `packages/core/src/emdash-runtime.ts`             | Central runtime; orchestrates DB, plugins, storage    |
| `packages/core/src/schema/registry.ts`            | Manages `ec_*` table creation/modification            |
| `packages/core/src/database/migrations/runner.ts` | StaticMigrationProvider; register new migrations here |
| `packages/core/src/plugins/manager.ts`            | Loads and orchestrates plugins                        |

# Code Patterns

## Database: Never Interpolate Into SQL

Kysely is the query builder.

- **Never** use `sql.raw()` with string interpolation or template literals containing variables.
- For **values**, use Kysely's `sql` tagged template -- interpolated values are automatically parameterized.
- For **identifiers** (table/column names), use `sql.ref()`.
- If you must use `sql.raw()` for dynamic identifiers, validate with `validateIdentifier()` from `database/validate.ts` first (asserts `/^[a-z][a-z0-9_]*$/`).
- The `json_extract(data, '$.${field}')` pattern is particularly dangerous -- always validate `field`.

```typescript
// WRONG -- SQL injection
const query = `SELECT * FROM ${table} WHERE name = '${name}'`;
await sql.raw(query).execute(db);

// RIGHT -- parameterized value, safe identifier
await sql`SELECT * FROM ${sql.ref(table)} WHERE name = ${name}`.execute(db);

// RIGHT -- validated identifier in raw SQL
validateIdentifier(field);
return sql.raw(`json_extract(data, '$.${field}')`);
```

## API Routes

Routes live in `packages/core/src/astro/routes/api/`. Conventions:

- Every route file starts with `export const prerender = false;`.
- Named exports: `export const GET: APIRoute`, etc. Destructure from the Astro context.
- Access runtime via `const { emdash } = locals;`, user via `locals.user`.
- File structure mirrors URLs: `content/[collection]/index.ts` for list/create, `[id].ts` for get/update/delete, sub-actions as siblings.
- **Never** add GET handlers for state-changing operations.

Use the shared utilities -- don't roll your own:

| Need            | Use                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------- |
| Error response  | `apiError(code, message, status)` from `#api/error.js`                                   |
| Catch block     | `handleError(error, message, code)` -- never expose `error.message` to clients           |
| Body validation | `parseBody(request, zodSchema)` from `#api/parse.js` -- never `as` cast `request.json()` |
| Unwrap handler  | `unwrapResult(result)` -- maps error codes to HTTP statuses automatically                |
| Init check      | `if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);`      |

The error helper is `mapErrorStatus`, not `mapErrorToStatus`.

### Authorization

Every state-changing route must check authorization. Authorization is permission-based, not role-based -- the `Permissions` map in `packages/auth/src/rbac.ts` is authoritative. Never invent permission strings in route files; add them to `rbac.ts` with a sensible minimum role.

```typescript
import { requirePerm, requireOwnerPerm } from "#api/authorize.js";

// Any-actor capability (settings, schema)
const denied = requirePerm(user, "schema:manage");
if (denied) return denied;

// Ownership-aware (authors edit their own; editors edit anyone's)
const denied = requireOwnerPerm(user, post.authorId, "content:edit_own", "content:edit_any");
if (denied) return denied;
```

Both helpers return `null` on success or a `Response` (401/403) to return directly.

### CSRF

All state-changing endpoints require the `X-EmDash-Request: 1` header, enforced by auth middleware. The admin UI and visual editing client send it automatically.

### Pagination

List endpoints return `{ items, nextCursor? }` -- never a bare array. Use `encodeCursor(orderValue, id)` / `decodeCursor(cursor)`. Default limit 50, max 100, always clamp. The repository-level shape is `FindManyResult<T>`.

### URL/Redirect handling

When accepting redirect URLs from query params or bodies: require leading `/`, reject `//`, HTML-escape before interpolation, prefer `Response.redirect()` over `<meta http-equiv="refresh">`.

## Handler Layer

Handlers in `api/handlers/*.ts` are standalone async functions, not class methods.

- First parameter is always `db: Kysely<Database>`, followed by route-specific params.
- Return `ApiResult<T>`.
- Wrap the body in try/catch. Errors return `{ success: false, error: { code, message } }`.
- Error codes are `SCREAMING_SNAKE_CASE` (`NOT_FOUND`, `VALIDATION_ERROR`, `CONTENT_CREATE_ERROR`).

## Migrations

Migrations live in `packages/core/src/database/migrations/`.

- **Naming:** `NNN_descriptive_name.ts`, zero-padded.
- **Exports:** `up(db: Kysely<unknown>)` and `down(db: Kysely<unknown>)`.
- **System tables:** Kysely schema builder.
- **Dynamic content tables (`ec_*`):** `sql` tagged templates with `sql.ref()` for identifiers.
- **Column types:** SQLite -- `text`, `integer`, `real`, `blob`. Booleans are `integer` defaulting to 0. Timestamps are `text` with ``defaultTo(sql`(datetime('now'))`)``. IDs are `text` primary keys (ULIDs from `ulidx`).
- **Registration:** Migrations are statically imported in `runner.ts` and added to `StaticMigrationProvider`. Not auto-discovered (Workers bundler compatibility). When adding: create the file, add a static import in `runner.ts`, add it to `getMigrations()`.
- **Multi-table migrations:** When altering all content tables, query `_emdash_collections` and loop. See `013_scheduled_publishing.ts`.

## Indexes

Every content table gets indexes on: `status`, `slug`, `created_at`, `deleted_at`, `scheduled_at` (partial, `WHERE scheduled_at IS NOT NULL`), `live_revision_id`, `draft_revision_id`, `author_id`, `primary_byline_id`, `updated_at`, `locale`, `translation_group`. Foreign key columns always get an index.

Naming: `idx_{table}_{column}` for single-column, `idx_{table}_{purpose}` for multi-column.

## Content Tables

Managed by `SchemaRegistry` in `schema/registry.ts`:

- **Names:** `ec_{collection_slug}`. System tables: `_emdash_{name}`.
- **Slugs:** `/^[a-z][a-z0-9_]*$/`, max 63 chars, checked against `RESERVED_COLLECTION_SLUGS` / `RESERVED_FIELD_SLUGS`.
- **Standard columns:** `id`, `slug`, `status`, `author_id`, `created_at`, `updated_at`, `published_at`, `scheduled_at`, `deleted_at`, `version`, `live_revision_id`, `draft_revision_id`. Field columns added via `ALTER TABLE`.
- **Field type -> column mapping:** `FIELD_TYPE_TO_COLUMN` in `schema/types.ts`. Most string-shaped types -> TEXT; number -> REAL; integer/boolean -> INTEGER; portableText/json/multiSelect -> JSON.
- **Orphan discovery:** `discoverOrphanedTables()` finds `ec_*` tables without a matching `_emdash_collections` row.

## Content Localization

Content tables use a row-per-locale model (migration `019_i18n.ts`):

- Every `ec_*` table has `locale` (defaults to `'en'`) and `translation_group` (ULID shared across translations).
- Slug uniqueness is `UNIQUE(slug, locale)`, not global.
- Any new query against a content table must filter by `locale` -- forgetting this is a correctness bug.
- Fetch all translations via `GET /_emdash/api/content/{collection}/{id}/translations`.

When adding content-table features, ask: per-locale (display fields) or per-translation-group (anything identifying "the same thing" across languages)?

## Performance: Caching and Query Patterns

EmDash runs on D1 with the Sessions API. Anonymous reads go to the nearest replica; writes and authenticated reads route to the primary. Every round-trip matters.

**Wrap query helpers in `requestCached`.** Per-request cache (`src/request-cache.ts`) dedupes identical calls within a render. If a helper takes stable args (slug, key, id) and may be called from multiple components, wrap it. The cache key must include every argument that changes the result. The promise is cached, so concurrent callers share the in-flight query.

```typescript
export function getSiteSetting(key: string) {
	return requestCached(`siteSetting:${key}`, async () => {
		const db = await getDb();
		return ...;
	});
}
```

**Module-scope singletons must live on `globalThis`.** Vite duplicates modules across SSR chunks; a plain `let cache = null` becomes two variables. Use a `Symbol.for` key on `globalThis`. See `packages/core/src/settings/index.ts` (versioned) and `packages/core/src/request-context.ts` / `request-cache.ts` (per-request).

**Prefer the batch query to a "has any" probe.** Don't add a `SELECT id FROM foo LIMIT 1` to skip work on empty sites -- on live sites you pay the extra query every request for no gain. Handle missing tables with `isMissingTableError`.

**Defer bookkeeping with `after(fn)`.** Maintenance writes don't need to block TTFB. `after()` uses workerd's `waitUntil` when available, fire-and-forgets on Node. Wrap your function body in try/catch with a module-specific log prefix.

```typescript
import { after } from "emdash";

after(async () => {
	try {
		await recoverStaleLocks();
	} catch (error) {
		console.error("[cron] recovery failed:", error);
	}
});
```

**One query beats two.** Use `LEFT JOIN` for parent+children. Batch with `WHERE id IN (...)`, chunked at `SQL_BATCH_SIZE` (from `utils/chunks.ts`) for D1's bind-parameter limit.

**Query-count snapshots.** `pnpm query-counts` (see `scripts/query-counts.mjs`) records per-route query counts in `scripts/query-counts.snapshot.{sqlite,d1}.json`. CI auto-updates on PRs -- review the diff. Fewer is always right; more needs a conversation.

# Admin UI

The admin (`packages/admin`) is a React SPA mounted under `/_emdash/admin/*`.

## Kumo Components

Built on [Kumo](https://github.com/cloudflare/kumo) (Cloudflare's design system). Never roll your own buttons, inputs, dialogs, etc. -- use Kumo. Get consistent styling, dark mode, accessibility, RTL for free.

Look up docs from the CLI:

```bash
npx @cloudflare/kumo doc Button   # specific component
npx @cloudflare/kumo ls           # list all
```

Common imports: `Button`, `LinkButton`, `Dialog`, `Input`, `InputArea`, `Select`, `Checkbox`, `Switch`, `Loader`, `Badge`, `Toast`/`Toasty`, `Popover`, `Dropdown`, `Tooltip`, `Label`, `CommandPalette`.

### Buttons and links

| Need                                      | Component                        |
| ----------------------------------------- | -------------------------------- |
| In-place action                           | `Button`                         |
| External link styled as a button          | `LinkButton href="..." external` |
| Internal router-aware link as a button    | `RouterLinkButton to="..."`      |
| Non-button element needing button classes | `buttonVariants(...)`            |

`RouterLinkButton` wraps TanStack Router's `<Link>` with Kumo button classes. Never write `<Link><Button>...</Button></Link>` (invalid `<a><button>` HTML). Never hand-roll button styling on an `<a>`.

### Styling rules

- Use semantic tokens (`bg-kumo-brand`, `text-kumo-subtle`). Never raw Tailwind colors.
- Never use `dark:` prefixes. Kumo's tokens use CSS `light-dark()`.
- Never duplicate component styles. If you're writing `bg-kumo-brand text-white rounded-md px-3 py-2` on a `<button>`, use Kumo's `Button` instead.

### Dialogs and errors

- `ConfirmDialog` (in `components/`) for confirm/cancel modals. Pass `mutation.error` directly -- don't manage error state manually.
- `DialogError` + `getMutationError()` for inline errors in form dialogs.
- Admin API client functions use `throwResponseError()` from `lib/api/client.ts` to surface server messages -- never `throw new Error("Failed to X")` and lose the body.

## Admin UI: Localization (Lingui)

Every user-facing string goes through Lingui. No hard-coded English in JSX, attributes, or strings that end up in the DOM.

- Catalogs: `packages/admin/src/locales/{locale}/messages.po`. English is source.
- Enabled locales: `packages/admin/src/locales/locales.ts`.
- **Don't include `messages.po` changes in non-translation PRs.** A workflow runs `pnpm locale:extract` on merge to `main`. Including extracted catalog updates in feature PRs creates merge churn -- revert before opening.
- Set `EMDASH_PSEUDO_LOCALE=1` in dev to render pseudo-localized text and spot untranslated leaks.

```typescript
import { useLingui } from "@lingui/react/macro";
import { Trans } from "@lingui/react/macro";

function DeleteButton() {
	const { t } = useLingui();
	return <button aria-label={t`Delete post`}>{t`Delete`}</button>;
}

// JSX with nested components
<Trans>Published by <strong>{authorName}</strong> on {formattedDate}</Trans>

// Pluralization
import { plural } from "@lingui/core/macro";
const label = plural(count, { one: "# item", other: "# items" });

// Module-scope constants: msg`` descriptors, resolved with t() in the component
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

const transforms: { id: string; label: MessageDescriptor }[] = [
	{ id: "paragraph", label: msg`Paragraph` },
];
// ...inside component: t(transforms[0].label)
```

Common mistakes:

- Bare string literals in JSX, unwrapped aria/title/placeholder/alt attributes.
- Concatenating translated pieces (`` t`Hello ` + name``) -- breaks word order. Use `` t`Hello ${name}` `` or `<Trans>`.
- Calling `t` at module scope -- locale isn't bound. Use `msg` + `t(descriptor)` inside a component.

Server-side error messages are English-only for now. Keep error codes stable (`SCREAMING_SNAKE_CASE`); the admin maps codes to localized messages client-side.

## Admin UI: RTL-safe Tailwind

The admin supports RTL locales. Use logical Tailwind classes, never physical:

| Use                           | Not                           |
| ----------------------------- | ----------------------------- |
| `ms-*` / `me-*`               | `ml-*` / `mr-*`               |
| `ps-*` / `pe-*`               | `pl-*` / `pr-*`               |
| `start-*` / `end-*`           | `left-*` / `right-*`          |
| `text-start` / `text-end`     | `text-left` / `text-right`    |
| `border-s` / `border-e`       | `border-l` / `border-r`       |
| `rounded-s-*` / `rounded-e-*` | `rounded-l-*` / `rounded-r-*` |
| `float-start` / `float-end`   | `float-left` / `float-right`  |

For directional icons (chevrons, arrows), flip them with `rtl:-scale-x-100` or use a bidi-aware icon.

`LocaleDirectionProvider` syncs `document.documentElement.dir`/`lang` automatically.

**Test new admin UI in Arabic** before declaring done. Broken directionality is the most common i18n regression.

# Conventions

## Imports

- **Internal imports** use `.js` extensions (ESM): `import { X } from "../foo.js"`.
- **Type-only imports** use `import type` (`verbatimModuleSyntax` is on).
- **Package imports** have no extension: `import { sql } from "kysely"`.
- **Virtual modules** need a `// @ts-ignore`: `// @ts-ignore - virtual module` above `import virtualConfig from "virtual:emdash/config"`.
- **Barrel files** separate `export type { ... }` from value exports.

## Environment

- Use `import.meta.env.DEV` / `import.meta.env.PROD` (Vite/Astro standard). Never `process.env.NODE_ENV`.
- Dev-only endpoints must check `import.meta.env.DEV` and return 403 otherwise -- it's a compile-time constant, unspoofable at runtime.
- Secrets pattern: `import.meta.env.EMDASH_X || import.meta.env.X || ""`.

## Cloudflare Env

Import `env` directly from `"cloudflare:workers"` -- a virtual module that resolves to the right bindings for the current environment (Worker or local dev).

Don't manually type the `Env` object. In a Worker context, run `pnpm wrangler types` to generate `worker-configuration.d.ts` (includes wrangler.jsonc bindings and `.env` secrets). Reference it in `tsconfig.json`'s `include`.

Local-dev secrets go in `.env` (read by Wrangler and the Cloudflare Vite plugin since Aug 2025), not `.dev.vars`. Note Wrangler loads either `.dev.vars` or `.env` but never both -- if a `.dev.vars` file exists it wins and `.env` is ignored entirely. Production secrets are set with `wrangler secret put`.

In libraries used in a Worker but not themselves Workers, install `@cloudflare/workers-types` and reference it in `tsconfig.compilerOptions.types`.

# Testing

- **Framework:** vitest. Tests in `packages/core/tests/`.
- **No mocks for the DB.** SQLite (`better-sqlite3`) by default. PostgreSQL parity tests via a real `pg` connection with per-test schema isolation (set `PG_CONNECTION_STRING` to opt in).
- **Utilities:** `tests/utils/test-db.ts` exposes `setupTestDatabase()`, `setupTestDatabaseWithCollections()`, `teardownTestDatabase()` for SQLite and `setupTestPostgresDatabase()` etc. for Postgres. Dialect-agnostic: `setupForDialect`, `setupForDialectWithCollections`, `teardownForDialect`, plus `describeEachDialect(name, fn)`. Use the dialect wrapper for query-builder code -- regressions tend to be dialect-specific.
- **Structure:** `tests/unit/`, `tests/integration/`, `tests/e2e/` (Playwright). Test files mirror source structure. Each test gets a fresh DB.

# Toolchain

- **pnpm** -- package manager
- **tsdown** -- TypeScript builds (ESM + DTS)
- **vitest** -- testing
- **oxfmt** -- formatting (tabs, configured in `.prettierrc`). All source files use tabs.

TypeScript: target ES2023, module `preserve`, strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.

# Dev Bypass for Browser Testing

Passkey auth can't be automated in browser tests. Two dev-only endpoints (`import.meta.env.DEV` only, 403 in prod):

- `GET /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` -- runs migrations, creates a dev admin user (`dev@emdash.local`), establishes a session, redirects.
- `GET /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin` -- assumes setup is complete, just creates a session.

In agent-browser:

```typescript
await page.goto("http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
```
