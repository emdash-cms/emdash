This file provides guidance to agentic coding tools when working with code in this repository.

## Project Status

**Beta, post pre-release.** EmDash is published to npm and in active use, with i18n, RTL, and the plugin system shipped. We're no longer in the scorched-earth pre-release phase -- real users depend on current behavior, so backwards compatibility now matters (see Rules below). All development happens inside this monorepo using `workspace:*` links. See [CONTRIBUTING.md](CONTRIBUTING.md) for the human-readable contributor guide (setup, repo layout, "build your own site" workflow).

## Repository Structure

This is a monorepo using pnpm workspaces.

`CLAUDE.md` is a symlink to `AGENTS.md`. `.opencode/skills` and `.claude/skills` are symlinks to `skills/`. Don't try to sync between them.

- **Root**: Workspace configuration and shared tooling
- **packages/core**: Main `emdash` package -- Astro integration, runtime, schema, API routes, CLI
- **packages/admin**: `@emdash-cms/admin` -- React admin UI shipped as a single mounted app under `/_emdash/admin/*`
- **packages/auth**: `@emdash-cms/auth` -- RBAC primitives (`Permissions`, `hasPermission`, `canActOnOwn`), passkey + magic link, RoleLevel ladder
- **packages/blocks**: `@emdash-cms/blocks` -- shared Portable Text block defs and renderers
- **packages/cloudflare**: `@emdash-cms/cloudflare` -- D1/R2/Workers integration helpers
- **packages/marketplace**: `@emdash-cms/marketplace` -- plugin/theme marketplace client
- **packages/x402**: `@emdash-cms/x402` -- HTTP 402 payment middleware
- **packages/create-emdash**: `create-emdash` -- scaffolding CLI for new sites
- **packages/gutenberg-to-portable-text**: WordPress import helper
- **demos/**: Demo applications and examples (`demos/simple/` is the primary dev target)
- **templates/**: Starter templates (blog, marketing, portfolio, starter, blank) -- contributors copy these into `demos/` to build their own sites
- **docs/**: Public documentation site (Starlight)

# Rules

**Backwards compatibility matters now.** We're out of pre-release, but pre-1.0. Real installs depend on current behavior, schemas, and API shapes. Breaking changes are allowed in minors, but need an explicit decision, a bump on the affected package, and a changeset that calls the break out clearly. Prefer additive changes: new fields, new routes, new options with sensible defaults. If an old API is obsolete, mark the replacement as preferred and keep the old path working unless there's a reason it can't. Database migrations are forward-only -- never write one that leaves existing content inaccessible. When in doubt, open a Discussion before coding.

**TDD for bugs.** Write a failing test -> fix the bug -> verify the test passes. A bug without a reproducing test is not fixed.

**Localize everything user-facing.** All admin UI strings, aria labels, and toast messages go through Lingui. All admin layout uses RTL-safe logical Tailwind classes. See the Localization and RTL sections below.

## Contribution Rules (for AI agents and human contributors)

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Key rules:

- **You MUST use the PR template.** Every PR must include the PR template with all sections filled out. The template is loaded automatically when you create a PR via the GitHub UI. If you create a PR via the API or CLI, copy the template from `.github/PULL_REQUEST_TEMPLATE.md` into the PR body. **PRs that do not use the template will be closed automatically by CI.**
- **Features require a prior approved Discussion.** Do not open a feature PR without one. It will be closed. Open a [Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) in the Ideas category first.
- **Bug fixes and docs** can be PRed directly.
- **Check every applicable checkbox** in the PR template, including the "I have read CONTRIBUTING.md" box and the AI disclosure box if any part of the code was AI-generated.
- **Do not make bulk/spray changes** (e.g., "fix all lint warnings", "add types everywhere", "improve error handling across codebase"). If you see a systemic issue, open a Discussion.
- **Do not touch code outside the scope of your change.** No drive-by refactors, no "while I'm here" improvements, no added comments or logging in unrelated files.
- **All CI checks must pass.** Typecheck, lint, format, and tests. No exceptions.
- **All non-trivial code changes should have an adversarial review.** Before opening the PR, perform cycles of adversarial review in a sub-agent, then fix, then re-review until no issues remain.

## Workflow

### Before Starting

1. Run `pnpm --silent lint:json | jq '.diagnostics | length'` and fix any issues. Non-negotiable.

### During Work

- Run `pnpm --silent lint:quick` after every edit -- takes less than a second. Returns JSON with stderr redirected to /dev/null, so it won't break parsers. Fix any issues immediately.
- Run `pnpm typecheck` (packages) or `pnpm typecheck:demos` (Astro demos) after each round of edits.
- Format regularly. pnpm format in the root uses oxfmt with tabs for indentation and is very fast. Don't let formatting pile up.
- Commit regularly, and always format and quick lint beforehand.

### Before Committing

You verified linting and types were clean before starting. If they're failing now, your changes caused it -- even if the errors are in files you didn't touch. Don't dismiss failures as "unrelated". Don't assign blame. Just fix them.

### Changesets

If your change affects a published package's behavior, add a changeset. Without one, the change won't trigger a package release.

```bash
pnpm changeset --empty
```

This creates a blank changeset file in `.changeset/`. Edit it to add the affected package(s), bump type, and description:

```markdown
---
"emdash": patch
---

Fixes CLI `--json` flag so JSON output is clean.
```

Start descriptions with a present-tense verb (Adds, Fixes, Updates, Removes, Refactors). Focus on what changes for the user, not implementation details.

Skip changesets for docs-only, test-only, CI, or demo/template changes.

See [CONTRIBUTING.md § Changesets](CONTRIBUTING.md#changesets) for full guidance and examples.

### PR Flow

1. All tests pass: `pnpm test`
2. Full lint suite clean: `pnpm --silent lint:json | jq '.diagnostics | length'`. Returns JSON with stderr piped to /dev/null, so it won't break parsers. Fix any issues.
3. Format with `pnpm format` (oxfmt with tabs for indentation, configured in `.prettierrc`).
4. Add a changeset if the change affects a published package: `pnpm changeset`.
5. Open the PR (via `gh pr create` or the GitHub UI). Fill out every section of the PR template -- copy `.github/PULL_REQUEST_TEMPLATE.md` into the body if using the API/CLI. Check the AI disclosure box if any code was AI-generated.

## Architecture Overview

EmDash is an Astro-native CMS

### Core Architecture

- **Schema in the database.** `_emdash_collections` and `_emdash_fields` are the source of truth. Each collection gets a real SQL table (`ec_posts`, `ec_products`) with typed columns -- not EAV.
- **Middleware chain** (in order): runtime init -> setup check -> auth -> request context (ALS). Auth middleware handles authentication; individual routes handle authorization.
- **Handler layer** (`api/handlers/*.ts`) -- Business logic returns `ApiResponse<T>` (`{ success, data?, error? }`). Route files are thin wrappers that parse input, call handlers, and format responses.
- **Storage abstraction** -- `Storage` interface with `upload/download/delete/exists/list/getSignedUploadUrl`. Implementations: `LocalStorage` (dev), `S3Storage` (R2/AWS). Access via `emdash.storage` from locals.

### Known Quality Patterns

**Index discipline.** Every content table gets indexes on: `status`, `slug`, `created_at`, `deleted_at`, `scheduled_at` (partial -- `WHERE scheduled_at IS NOT NULL`), `live_revision_id`, `draft_revision_id`, `author_id`, `primary_byline_id`, `updated_at`, `locale`, `translation_group`. Foreign key columns always get an index. Naming: `idx_{table}_{column}` for single-column, `idx_{table}_{purpose}` for multi-column.

**API envelope consistency.** Handlers return `ApiResponse<T>` wrapping data in `{ success, data }`. List endpoints return `{ items, nextCursor? }` inside `data`. The admin client's `parseApiResponse` unwraps `body.data`. Be aware of this layering when adding new endpoints.

## Commands

### Root-level commands (run from repository root):

- `pnpm build` - Build all packages
- `pnpm test` - Run tests for all packages
- `pnpm check` - Run type checking and linting for all packages
- `pnpm format` - Format code using oxfmt

### Package-level commands (run within individual packages):

- `pnpm build` - Build the package using tsdown (ESM + DTS output)
- `pnpm dev` - Watch mode for development
- `pnpm test` - Run vitest tests
- `pnpm check` - Run publint and @arethetypeswrong/cli checks

## Key Files

| File                                | Purpose                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `src/live.config.ts`                | Collection schemas + admin config (user's site)       |
| `src/emdash-runtime.ts`             | Central runtime; orchestrates DB, plugins, storage    |
| `src/schema/registry.ts`            | Manages `ec_*` table creation/modification            |
| `src/database/migrations/runner.ts` | StaticMigrationProvider; register new migrations here |
| `src/plugins/manager.ts`            | Loads and orchestrates trusted plugins                |

## Code Patterns

### Database: Never Interpolate Into SQL

Kysely is the query builder. Use it properly:

- **Never** use `sql.raw()` with string interpolation or template literals containing variables.
- **Never** build SQL strings with `+` or backtick interpolation and pass them to `sql.raw()`.
- For **values**, use Kysely's `sql` tagged template: `` sql`SELECT * FROM t WHERE id = ${id}` `` -- interpolated values are automatically parameterized.
- For **identifiers** (table/column names), use `sql.ref()` which quotes them safely.
- If you absolutely must use `sql.raw()` for dynamic identifiers, validate them first with `validateIdentifier()` from `database/validate.ts` which asserts `/^[a-z][a-z0-9_]*$/`.
- The `json_extract(data, '$.${field}')` pattern is particularly dangerous -- always validate `field` before interpolation.

```typescript
// WRONG -- SQL injection via string interpolation
const query = `SELECT * FROM ${table} WHERE name = '${name}'`;
await sql.raw(query).execute(db);

// WRONG -- field name interpolated into sql.raw()
return sql.raw(`json_extract(data, '$.${field}')`);

// RIGHT -- parameterized value
await sql`SELECT * FROM ${sql.ref(table)} WHERE name = ${name}`.execute(db);

// RIGHT -- validated identifier in raw SQL
validateIdentifier(field);
return sql.raw(`json_extract(data, '$.${field}')`);
```

### API Routes: Use Shared Utilities

All API routes under `astro/routes/api/` must follow these patterns:

**Error responses** -- use `apiError()` from `api/error.ts`:

```typescript
// WRONG -- inline JSON.stringify with ad-hoc shape
return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

// RIGHT -- consistent shape: { error: { code, message } }
return apiError("NOT_FOUND", "Content not found", 404);
```

**Catch blocks** -- use `handleError()`, never expose `error.message` to clients:

```typescript
// WRONG -- leaks internal error details
catch (error) {
  return new Response(JSON.stringify({
    error: error instanceof Error ? error.message : "Unknown error"
  }), { status: 500 });
}

// RIGHT -- logs internally, returns generic message
catch (error) {
  return handleError(error, "Failed to update content", "CONTENT_UPDATE_ERROR");
}
```

**Input validation** -- use `parseBody()` / `parseQuery()` from `api/parse.ts`, never use `as` casts on `request.json()`:

```typescript
// WRONG -- no runtime validation, malformed input reaches the database
const body = (await request.json()) as CreateContentInput;

// RIGHT -- Zod validation, returns 400 on failure
const body = await parseBody(request, createContentSchema);
```

**Initialization checks** -- use a consistent message:

```typescript
if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
```

**Handler results** -- prefer the `unwrapResult()` helper over manual unwrapping:

```typescript
import { unwrapResult } from "#api/error.js";

// RIGHT -- one-liner; returns the right status from the error code automatically
const result = await handleContentGet(db, collection, id);
return unwrapResult(result);

// Manual unwrap is only needed when you want to do something between the
// success check and the response (e.g. set a custom header):
import { apiError, mapErrorStatus } from "#api/error.js";
if (!result.success) {
	return apiError(result.error.code, result.error.message, mapErrorStatus(result.error.code));
}
return Response.json(result.data);
```

Note the function is named `mapErrorStatus`, not `mapErrorToStatus`.

### API Routes: Authorization

Every route that modifies state must check authorization. The auth middleware only checks authentication (is the user logged in); individual routes must check **permissions**.

Authorization is permission-based, not role-based. The `Permissions` map in `@emdash-cms/auth` (see `packages/auth/src/rbac.ts`) lists every gate -- `"content:read_drafts"`, `"content:edit_own"`, `"content:edit_any"`, `"schema:manage"`, `"media:upload"`, etc. -- and binds each to a minimum `RoleLevel`. Roles still exist as the underlying ladder (SUBSCRIBER < CONTRIBUTOR < AUTHOR < EDITOR < ADMIN), but route code never references them directly.

Use the helpers from `#api/authorize.js`:

```typescript
import { requirePerm, requireOwnerPerm } from "#api/authorize.js";

// Simple permission check -- use for any-actor capabilities (settings, schema, etc.)
const denied = requirePerm(user, "schema:manage");
if (denied) return denied;

// Ownership-aware check -- use for resources where authors can act on their own
// but only editors can act on anyone else's. Pass the resource owner's id and
// both the "own" and "any" permissions.
const denied = requireOwnerPerm(user, post.authorId, "content:edit_own", "content:edit_any");
if (denied) return denied;
```

`requirePerm` returns `null` on success, or a `Response` (401 if unauthenticated, 403 if authorized but missing the permission) that you should return directly. Same shape for `requireOwnerPerm`.

To find the right permission string for a new endpoint, scan `packages/auth/src/rbac.ts`. If no existing permission fits, add one there with a sensible minimum role -- this is the authoritative list. Never invent a permission string in a route file.

### API Routes: CSRF Protection

All state-changing endpoints (POST/PUT/DELETE) require the `X-EmDash-Request: 1` header, enforced by auth middleware. The admin UI and visual editing client send this header automatically. Do not add GET handlers for state-changing operations.

### Pagination

All list endpoints must use cursor-based pagination with a consistent shape:

```typescript
// Return type for all list queries
interface FindManyResult<T> {
	items: T[];
	nextCursor?: string;
}
```

- Use `encodeCursor(orderValue, id)` / `decodeCursor(cursor)` utilities.
- Default limit: 50. Maximum limit: 100. Always clamp.
- The response array key is always `items` (not `results`, not a bare array).
- Never return a bare array from a list endpoint -- always wrap in `{ items, nextCursor? }`.

### Adding Database Tables or Columns

When creating tables or adding columns queried in WHERE or ORDER BY clauses, add indexes. Check existing patterns in `database/migrations/` and `schema/registry.ts`. Foreign key columns should always have an index.

Index naming: `idx_{table}_{column}` for single-column, `idx_{table}_{purpose}` for multi-column. Content tables get standard indexes on `status`, `slug`, `created_at`, `deleted_at`, `author_id`, and all foreign key columns.

### Migrations

Migrations live in `packages/core/src/database/migrations/`. Conventions:

- **Naming:** `NNN_descriptive_name.ts` -- zero-padded 3-digit sequential number.
- **Exports:** Each migration exports `up(db: Kysely<unknown>)` and `down(db: Kysely<unknown>)`.
- **System tables** use Kysely's schema builder (`db.schema.createTable(...)`).
- **Dynamic content tables** (`ec_*`) use `sql` tagged templates with `sql.ref()` for identifiers.
- **Column types:** SQLite types -- `"text"`, `"integer"`, `"real"`, `"blob"`. Booleans are `"integer"` with `defaultTo(0)`. Timestamps are `"text"` with ``defaultTo(sql`(datetime('now'))`)``. IDs are `"text"` primary keys (ULIDs from `ulidx`).
- **Index naming:** `idx_{table}_{column}` for single-column, `idx_{table}_{purpose}` for multi-column.
- **Foreign keys** must always have an accompanying index.
- **Registration:** Migrations are statically imported in `database/runner.ts` and added to the `StaticMigrationProvider`. They are NOT auto-discovered -- this is required for Workers bundler compatibility. When adding a migration: (1) create the file, (2) add a static import in `runner.ts`, (3) add it to `getMigrations()`.
- **Multi-table migrations:** When altering all content tables, query `_emdash_collections` to discover `ec_*` tables and loop. See `013_scheduled_publishing.ts` for the pattern.

### API Route Structure

Route files live in `packages/core/src/astro/routes/api/`. Conventions:

- Every route file starts with `export const prerender = false;`.
- Handlers are named exports: `export const GET: APIRoute`, `export const POST: APIRoute`, etc.
- Handlers destructure from the Astro context: `({ params, request, url, locals })`.
- Access the CMS runtime via `const { emdash } = locals;`.
- Access the user via `const user = (locals as { user?: User }).user;`.
- URL structure mirrors file structure: `content/[collection]/index.ts` for list/create, `content/[collection]/[id].ts` for get/update/delete, with sub-actions as siblings: `[id]/publish.ts`, `[id]/schedule.ts`.
- **Never** add GET handlers for state-changing operations.

### Handler Layer

Handlers in `api/handlers/*.ts` contain business logic. Routes should be thin wrappers.

- Handlers are standalone async functions (not class methods).
- First parameter is always `db: Kysely<Database>`, followed by route-specific params.
- Always return `ApiResponse<T>` -- the `{ success, data?, error? }` discriminated union from `api/types.ts`.
- Entire body wrapped in try/catch. Errors return `{ success: false, error: { code, message } }`.
- Error codes are `SCREAMING_SNAKE_CASE`: `NOT_FOUND`, `VALIDATION_ERROR`, `CONTENT_CREATE_ERROR`, etc.

### Performance: caching and query patterns

EmDash runs on D1 with the Sessions API. Anonymous reads go to the nearest replica; writes and authenticated reads route to the primary. The primary is thousands of miles from some CF colos -- every round-trip matters, especially on cold isolates.

A few rules and patterns cover 90% of the footguns.

**Always add requestCached to query helpers called from templates.** Page-level template code runs inside the ALS request context, so the per-request cache (`src/request-cache.ts`) deduplicates identical calls within a single render. A single un-cached helper called from three widgets turns into three primary-routed reads on a page that should have made one. Rule of thumb: if a helper takes stable arguments (slug, key, entry ID) and can be called from multiple components, wrap it.

```typescript
// WRONG — every caller re-queries
export async function getSiteSetting(key: string) {
	const db = await getDb();
	return db.selectFrom("options").where("name", "=", key)...
}

// RIGHT — shared within one render
export function getSiteSetting(key: string) {
	return requestCached(`siteSetting:${key}`, async () => {
		const db = await getDb();
		return ...;
	});
}
```

The cache key must include every argument that changes the result. Missing an argument means wrong values get served; including too much just means more cache misses.

`requestCached` caches the _promise_, so concurrent callers share the in-flight query. On error the entry is deleted so the next call retries.

**Module-scope singletons must live on `globalThis`.** Vite duplicates modules across chunks during SSR bundling. A plain `let cache: X | null = null` in a module becomes _two_ variables if two chunks inline the module -- defeating the singleton. Use a `Symbol.for` key on `globalThis`, as `request-context.ts` does. See also `packages/core/src/bylines/index.ts` (`bylinesHolder`) for the pattern applied to a boolean cache. The fix cut ~2 cold-start queries per D1 isolate.

**Prefer the batch query to a "has any" probe.** Adding a `SELECT id FROM foo LIMIT 1` before a batch query to skip it on empty sites trades one extra query on every real request for saving one query on sites that almost never exist. On live sites the batch query returns empty at the same cost; handle missing tables with an `isMissingTableError` catch.

**Defer bookkeeping past the response with `after(fn)`.** Maintenance writes (cron recovery, audit log flushes) don't need to block TTFB. `after(fn)` hands the promise to workerd's `waitUntil` when available, or fire-and-forgets on Node. Errors are caught and logged with the `[emdash]` prefix -- add your own `try/catch` inside `fn` with a module-specific prefix (e.g. `[cron]`) for better grep-ability. Deferred writes still happen; they just don't gate the response.

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

**One query beats two whenever possible.** Every query pays a round-trip to the replica (and the primary for writes). If you're fetching parent + children, use a `LEFT JOIN`. If you're fetching related records by a list of IDs, batch with `WHERE id IN (...)` -- but chunk at `SQL_BATCH_SIZE` (from `utils/chunks.ts`) to stay below D1's bind-parameter limit.

**Every new helper gets a query-count impact check.** The fixture harness (`pnpm query-counts`, see `scripts/query-counts.mjs`) builds `fixtures/perf-site/` and records per-route query counts in `scripts/query-counts.snapshot.{sqlite,d1}.json`. CI auto-updates the snapshots on PRs; review the diff. Fewer queries on a route is always the right direction. More requires a conversation.

### Admin UI: Use Kumo Components

The admin UI is built on [Kumo](https://github.com/cloudflare/kumo) (Cloudflare's design system). Use Kumo components for all standard UI elements -- never roll your own buttons, inputs, dialogs, selects, etc. This gives us consistent styling, dark mode, accessibility, and RTL support for free.

**Look up component docs from the CLI** -- don't guess at props:

```bash
npx @cloudflare/kumo doc Button    # docs for a specific component
npx @cloudflare/kumo ls            # list all available components
npx @cloudflare/kumo docs          # docs for everything
```

Key components (all from `@cloudflare/kumo`):

- **`Button`** -- all clickable actions. Supports `variant`, `size`, `icon`, and `loading`.
- **`LinkButton`** -- anchor styled as a button. Use for navigation, never `<a>` with manual styling. Supports `external` prop for new-tab links.
- **`Dialog`** -- all modals. Use `ConfirmDialog` (ours) for simple confirm/cancel flows.
- **`Input`**, **`InputArea`**, **`Select`**, **`Checkbox`**, **`Switch`** -- form controls.
- **`Toast`** / **`Toasty`** -- notifications.
- **`Loader`** -- loading spinners.
- **`Badge`** -- status labels, counts.
- **`Popover`**, **`Dropdown`**, **`Tooltip`** -- overlays.
- **`CommandPalette`** -- the admin command palette.
- **`Label`** -- form labels (pairs with inputs).

```typescript
import { Button, LinkButton, Loader } from "@cloudflare/kumo";

// loading prop -- shows spinner and disables interaction automatically
<Button variant="primary" loading={mutation.isPending}>
	{t`Save`}
</Button>

// icon prop with conditional Loader -- use when the icon itself changes per state
// (e.g. different icons for idle/pending/done -- see SaveButton.tsx for the full pattern)
<Button
	variant={isSaved ? "secondary" : "primary"}
	icon={isSaving ? <Loader size="sm" /> : isSaved ? <Check /> : <FloppyDisk />}
	disabled={isSaving || isSaved}
	aria-busy={isSaving}
>
	{isSaving ? t`Saving...` : isSaved ? t`Saved` : t`Save`}
</Button>

// icon prop -- pass a Phosphor icon component or React element
<Button variant="secondary" icon={PlusIcon}>{t`Add item`}</Button>

// icon-only buttons require shape + aria-label
<Button shape="square" icon={TrashIcon} aria-label={t`Delete`} variant="ghost" />

// LinkButton for navigation -- never use <a> with manual button classes
<LinkButton href="/_emdash/admin" variant="ghost" icon={HouseIcon}>
	{t`Dashboard`}
</LinkButton>

// external links open in new tab with rel="noopener noreferrer"
<LinkButton href="https://docs.example.com" external>{t`Docs`}</LinkButton>
```

**Styling rules:**

- **Use semantic color tokens**, not raw Tailwind colors. `bg-kumo-brand` not `bg-blue-500`. `text-kumo-subtle` not `text-gray-500`. The full token list is in the Kumo styles.
- **Never use `dark:` prefixes.** Kumo's semantic tokens use CSS `light-dark()` to handle dark mode automatically. If you're writing `dark:bg-something`, you're bypassing the design system.
- Don't reach for raw HTML elements or Tailwind-only solutions when a Kumo component exists. If you need a button, use `Button`. If you need a link that looks like a button, use `LinkButton`. If you need `buttonVariants()` classes on a non-button element, import `buttonVariants` from `@cloudflare/kumo`.

### Admin UI: Localization (Lingui)

Every user-facing string in the admin UI goes through Lingui. No hard-coded English literals in JSX, attributes, or TypeScript strings that end up in the DOM.

- Catalogs live in `packages/admin/src/locales/{locale}/messages.po`. English is the source.
- Enabled locales are defined in `packages/admin/src/locales/locales.ts`.
- After adding or changing strings, run `pnpm locale:extract` then `pnpm locale:compile`. CI fails if catalogs are stale.
- Set `EMDASH_PSEUDO_LOCALE=1` in dev to render pseudo-localized text -- any untranslated English leaking through is immediately visible.

```typescript
import { useLingui } from "@lingui/react/macro";
import { Trans } from "@lingui/react/macro";

// Simple strings -- tagged template
function DeleteButton() {
	const { t } = useLingui();
	return (
		<button type="button" aria-label={t`Delete post`}>
			{t`Delete`}
		</button>
	);
}

// JSX with interpolation or nested components -- <Trans> macro
<Trans>
	Published by <strong>{authorName}</strong> on {formattedDate}
</Trans>;

// Pluralization -- use plural macro
import { plural } from "@lingui/core/macro";
const label = plural(count, { one: "# item", other: "# items" });

// Module-scope constants -- use msg`` descriptors, resolve with t() inside component
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

interface BlockTransform {
	id: string;
	label: MessageDescriptor;
}

const blockTransforms: BlockTransform[] = [
	{ id: "paragraph", label: msg`Paragraph` },
	{ id: "heading1", label: msg`Heading 1` },
];

function BlockMenu() {
	const { t } = useLingui();
	return blockTransforms.map((b) => <span key={b.id}>{t(b.label)}</span>);
}
```

Common mistakes to avoid:

- **Bare string literals in JSX**: `<button>Save</button>` -- must be `<button>{t\`Save\`}</button>`or`<button><Trans>Save</Trans></button>`.
- **Unwrapped aria labels, titles, placeholders, alt text**: these are user-facing too. `aria-label="Close"` -> ``aria-label={t`Close`}``.
- **Concatenating translated pieces**: ``t`Hello ` + name`` breaks word order in other languages. Use `` t`Hello ${name}` `` or `<Trans>`.
- **Calling `t` at module scope**: the locale isn't bound yet. Use `msg` to create a `MessageDescriptor`, then resolve it with `t(descriptor)` inside the component. Type the constant as `MessageDescriptor` (from `@lingui/core`).
- **Reusing the same key for different meanings**: give them distinct messages or use context.

Server-side (API error messages): still English-only for now. Keep error codes stable (`SCREAMING_SNAKE_CASE`) -- the admin UI maps codes to localized messages client-side.

### Admin UI: RTL-safe Tailwind

The admin supports RTL locales. Use logical Tailwind classes, never physical ones. An LTR-only class that slips in will misplace UI in Arabic.

| Use                                          | Not                           |
| -------------------------------------------- | ----------------------------- |
| `ms-*` / `me-*` (margin-inline-start/end)    | `ml-*` / `mr-*`               |
| `ps-*` / `pe-*` (padding-inline-start/end)   | `pl-*` / `pr-*`               |
| `start-*` / `end-*` (inset-inline-start/end) | `left-*` / `right-*`          |
| `text-start` / `text-end`                    | `text-left` / `text-right`    |
| `border-s` / `border-e`                      | `border-l` / `border-r`       |
| `rounded-s-*` / `rounded-e-*`                | `rounded-l-*` / `rounded-r-*` |
| `float-start` / `float-end`                  | `float-left` / `float-right`  |

For icons that indicate direction (chevrons, arrows, back/forward), flip them in RTL. Use `rtl:-scale-x-100` on the icon, or pick a bidi-aware icon. Don't rely on the icon being visually neutral.

`LocaleDirectionProvider` (`packages/admin/src/locales/LocaleDirectionProvider.tsx`) syncs `document.documentElement.dir` and `lang` with the active locale. You don't need to set these manually.

**Always test new admin UI in Arabic** before considering it done. Switch the locale in the admin and walk through the feature. Broken directionality is the single most common i18n regression.

### Content Localization

Content tables use a row-per-locale model (see migration `019_i18n.ts`):

- Every `ec_*` table has a `locale` column (defaults to `'en'`) and a `translation_group` ULID shared across translations of the same piece of content.
- Slug uniqueness is `UNIQUE(slug, locale)` -- not global. Two posts can share a slug across locales.
- Any new query against a content table must filter by `locale` or deliberately operate across locales (e.g. the translations endpoint). Forgetting the filter is a correctness bug, not a style issue.
- Indexes exist on both `locale` and `translation_group`. Use them.
- Fetch all translations of a single piece via `GET /_emdash/api/content/{collection}/{id}/translations`.

When adding new content-table features (new columns, new filters, new list endpoints), ask: does this need to be per-locale or per-translation-group? Per-locale is usually correct for display fields; per-group is correct for anything identifying "the same thing" across languages (e.g. comment counts, view counts might aggregate across the group).

### Admin UI: API Error Handling

All admin API functions use `throwResponseError()` from `lib/api/client.ts` to surface server error messages to the user. Never throw a generic error when the response body contains a message.

```typescript
import { apiFetch, throwResponseError } from "./client.js";

// WRONG -- loses the server's error message
if (!response.ok) throw new Error("Failed to create term");

// WRONG -- manually parsing what throwResponseError already does
if (!response.ok) {
	const errorData = await response.json().catch(() => ({}));
	throw new Error(errorData.error?.message || "Failed to create term");
}

// RIGHT -- parses { error: { message } } body, falls back to generic message
if (!response.ok) await throwResponseError(response, "Failed to create term");
```

### Admin UI: Confirmation Dialogs

Use `ConfirmDialog` from `components/ConfirmDialog.tsx` for all confirmation modals (delete, disable, demote, etc.). Pass `mutation.error` directly -- don't manage error state manually.

```typescript
import { ConfirmDialog } from "./ConfirmDialog.js";

<ConfirmDialog
  open={!!deleteSlug}
  onClose={() => { setDeleteSlug(null); deleteMutation.reset(); }}
  title="Delete Section?"
  description="This will permanently delete the section."
  confirmLabel="Delete"
  pendingLabel="Deleting..."
  isPending={deleteMutation.isPending}
  error={deleteMutation.error}
  onConfirm={() => deleteMutation.mutate(deleteSlug)}
/>
```

### Admin UI: Inline Dialog Errors

For form dialogs and other cases where `ConfirmDialog` doesn't fit, use `DialogError` and `getMutationError()` from `components/DialogError.tsx`:

```typescript
import { DialogError, getMutationError } from "./DialogError.js";

// In JSX -- renders nothing when message is null
<DialogError message={getMutationError(createMutation.error)} />

// With local error state fallback (e.g. client-side validation)
<DialogError message={localError || getMutationError(mutation.error)} />
```

Don't duplicate the error banner styling inline -- always use `DialogError`.

### Import Conventions

- **Internal imports** always use `.js` extensions (ESM requirement):
  ```typescript
  import { ContentRepository } from "../../database/repositories/content.js";
  ```
- **Type-only imports** must use `import type` (enforced by `verbatimModuleSyntax: true`):
  ```typescript
  import type { Kysely } from "kysely";
  ```
- **Package imports** do not use extensions: `import { sql } from "kysely"`.
- **Virtual modules** use `// @ts-ignore` comment:
  ```typescript
  // @ts-ignore - virtual module
  import virtualConfig from "virtual:emdash/config";
  ```
- **Barrel files** (`index.ts`) re-export from sub-modules. Separate `export type { ... }` from value exports.

### Environment Gating

- **Dev-only endpoints** must check `import.meta.env.DEV` and return 403 if false. This is a compile-time constant -- it cannot be spoofed at runtime.
- **Never** use `process.env.NODE_ENV` -- always use `import.meta.env.DEV` or `import.meta.env.PROD` (Vite/Astro standard).
- **Secrets** follow the pattern: `import.meta.env.EMDASH_X || import.meta.env.X || ""` -- check prefixed name first, then generic, then fallback.

### Cloudflare Env

To access the Cloudflare `env` object, import it directly from `"cloudflare:workers"` -- no need to access it from the context in a handler. This is a virtual module that resolves to the correct bindings for the current environment, whether that's a Worker or a local dev environment.

Do not manually type the Cloudflare Env object. When in a Worker context, run `pnpm wrangler types` to generate `worker-configuration.d.ts` with the correct bindings for the current environment. This includes types for bindings in wrangler.jsonc as well as secrets in `.dev.vars`. Regenerate it if you edit the bindings. Ensure it is referenced in `tsconfig.json` under `include` and then the types will be available globally.

If not working in a Worker context, but in a library that will be used in a Worker, install `@cloudflare/workers-types` and reference it in `tsconfig.json` under `compilerOptions.types`. This will allow you to use Cloudflare-specific types like `R2Bucket` and `D1Database` in your code.

### Content Table Lifecycle

Dynamic content tables are managed by `SchemaRegistry` in `schema/registry.ts`:

- **Table names:** `ec_{collection_slug}` (e.g., `ec_posts`). System tables: `_emdash_{name}`.
- **Slug validation:** `/^[a-z][a-z0-9_]*$/`, max 63 chars. Checked against `RESERVED_COLLECTION_SLUGS` and `RESERVED_FIELD_SLUGS`.
- **Standard columns:** Every content table gets `id`, `slug`, `status`, `author_id`, `created_at`, `updated_at`, `published_at`, `scheduled_at`, `deleted_at`, `version`, `live_revision_id`, `draft_revision_id`. User-defined field columns are added via `ALTER TABLE`.
- **Field type mapping:** `FIELD_TYPE_TO_COLUMN` maps: string/text/datetime/image/reference -> TEXT, number -> REAL, integer/boolean -> INTEGER, portableText/json -> JSON.
- **Orphan discovery:** `discoverOrphanedTables()` finds `ec_*` tables without matching `_emdash_collections` entries. This is used for recovering from crashes during schema changes.

### Testing

- **Framework:** vitest. Tests in `packages/core/tests/`.
- **Database:** Tests use real databases, never mocks. SQLite (`better-sqlite3`) for the default in-memory case; PostgreSQL via a real `pg` connection with per-test schema isolation for parity tests of dialect-sensitive code (set `PG_CONNECTION_STRING` to opt in).
- **Utilities:** `tests/utils/test-db.ts` provides:
  - SQLite: `createTestDatabase()`, `setupTestDatabase()` (runs migrations), `setupTestDatabaseWithCollections()` (migrations + standard post/page collections), `teardownTestDatabase()`
  - Postgres: `setupTestPostgresDatabase()`, `setupTestPostgresDatabaseWithCollections()`, `teardownTestPostgresDatabase()`
  - Dialect-agnostic: `setupForDialect(dialect)`, `setupForDialectWithCollections(dialect)`, `teardownForDialect(ctx)`, plus a `describeEachDialect(name, fn)` wrapper that runs the same test suite against each dialect. Use this for any code that builds queries -- regressions tend to be SQLite-only or Postgres-only.
- **Structure:** `tests/unit/` for unit, `tests/integration/` for integration (real DB), `tests/e2e/` for Playwright. Test files mirror source structure.
- **Lifecycle:** Each test gets a fresh DB in `beforeEach`, destroyed in `afterEach`.

### URL and Redirect Handling

When accepting redirect URLs from query params or request bodies:

- Validate the URL starts with `/` (relative path only).
- Reject URLs starting with `//` (protocol-relative -- would redirect to external hosts).
- HTML-escape any URL values before interpolating into HTML responses.
- Prefer server-side `Response.redirect()` over HTML `<meta http-equiv="refresh">`.

## Toolchain

- **pnpm** -- package manager
- **tsdown** -- TypeScript builds (ESM + DTS)
- **vitest** -- testing
- **oxfmt** -- code formatting (tabs for indentation). All source files use tabs, not spaces.

## TypeScript Configuration

- Target: ES2022
- Module: preserve (for bundler compatibility)
- Strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`

## Dev Bypass for Browser Testing

EmDash uses passkey authentication which cannot be automated in browser tests. Two dev-only endpoints are available to bypass authentication:

### Setup Bypass

Skips the setup wizard, runs migrations, creates a dev admin user, and establishes a session:

```
GET /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

### Auth Bypass

Creates a session for the dev admin user (assumes setup is already complete):

```
GET /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin
```

### Usage in Agent Browser

When testing the admin UI with agent-browser, navigate to the setup bypass URL first:

```typescript
await page.goto("http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
```

This will:

1. Run database migrations
2. Create a dev admin user (`dev@emdash.local`)
3. Set up a session cookie
4. Redirect to the admin dashboard

**Note**: These endpoints only work when `import.meta.env.DEV` is true. They return 403 in production.
