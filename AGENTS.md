This file provides guidance to agentic coding tools when working with code in this repository.

## Project Status

**Beta.** EmDash is published to npm. All development happens inside this monorepo using `workspace:*` links. See [CONTRIBUTING.md](CONTRIBUTING.md) for the human-readable contributor guide (setup, repo layout, "build your own site" workflow).

## Repository Structure

This is a monorepo using pnpm workspaces.

`CLAUDE.md` is a symlink to `AGENTS.md`. `.opencode/skills` and `.claude/skills` are symlinks to `skills/`. Don't try to sync between them.

- **Root**: Workspace configuration and shared tooling
- **packages/core**: Main `emdash` package - Astro integration and core APIs
- **demos/**: Demo applications and examples (`demos/simple/` is the primary dev target)
- **templates/**: Starter templates (blog, marketing, portfolio, starter, blank) -- contributors copy these into `demos/` to build their own sites
- **docs/**: Public documentation site (Starlight)

# Rules

This is a pre-release project. Do not add backwards compatibility or legacy patterns. Do not deprecate -- remove instead. Do not add migration paths.

**Build for the known future.** If we know we'll need something, build it now. Only defer things where there's genuine uncertainty about whether or how we'll need them. "We'll need it later" is a reason to do it now, not a reason to punt.

**TDD for bugs.** Write a failing test -> fix the bug -> verify the test passes. A bug without a reproducing test is not fixed.

## Contribution Rules (for AI agents and human contributors)

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Key rules:

- **You MUST use the PR template.** Every PR must include the PR template with all sections filled out. The template is loaded automatically when you create a PR via the GitHub UI. If you create a PR via the API or CLI, copy the template from `.github/PULL_REQUEST_TEMPLATE.md` into the PR body. **PRs that do not use the template will be closed automatically by CI.**
- **Features require a prior approved Discussion.** Do not open a feature PR without one. It will be closed. Open a [Discussion](https://github.com/emdash-cms/emdash/discussions/categories/ideas) in the Ideas category first.
- **Bug fixes and docs** can be PRed directly.
- **Check every applicable checkbox** in the PR template, including the "I have read CONTRIBUTING.md" box and the AI disclosure box if any part of the code was AI-generated.
- **Do not make bulk/spray changes** (e.g., "fix all lint warnings", "add types everywhere", "improve error handling across codebase"). If you see a systemic issue, open a Discussion.
- **Do not touch code outside the scope of your change.** No drive-by refactors, no "while I'm here" improvements, no added comments or logging in unrelated files.
- **All CI checks must pass.** Typecheck, lint, format, and tests. No exceptions.

## Workflow

### Before Starting

1. Run `pnpm --silent lint:json | jq '.diagnostics | length'` and fix any issues. Non-negotiable.

### During Work

- Run `pnpm --silent lint:quick` after every edit -- takes less than a second. Returns JSON with stderr redirected to /dev/null, so it won't break parsers. Fix any issues immediately.
- Run `pnpm typecheck` (packages) or `pnpm typecheck:demos` (Astro demos) after each round of edits.
- Format regularly. pnpm format in the root uses oxfmt with tabs for indentation and is very fast. Don't let formatting pile up.
- Commit regularly, and always format and quick lint beforehand.
- Update tasks.md when completing tasks. Write a journal entry when starting or finishing significant work, or if you learn anything interesting or useful that you'd like to remember.

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
5. Open the PR with the `pr` skill. Fill out every section of the PR template. Check the AI disclosure box.

### Dev Servers

Use `bgproc` (not raw process management):

```bash
bgproc start -n devserver -w -- pnpm dev   # start and wait for port
bgproc stop devserver                       # stop
bgproc logs devserver                       # view logs
```

## Architecture Overview

EmDash is an Astro-native CMS that stores its schema in the database, not in code.

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

**Handler results** -- when using the handler layer (`api/handlers/*.ts`), always unwrap consistently:

```typescript
const result = await handler.handleContentGet(collection, id);
if (!result.success) {
	return apiError(result.error.code, result.error.message, mapErrorToStatus(result.error.code));
}
return Response.json(result.data);
```

### API Routes: Authorization

Every route that modifies state must check authorization. The auth middleware only checks authentication (is the user logged in); individual routes must check roles:

```typescript
import { requireRole, Role } from "../../auth/permissions.js";

// At the top of any state-changing handler:
const roleError = requireRole(user, Role.EDITOR);
if (roleError) return roleError;
```

Minimum roles:

- **ADMIN**: settings, schema, plugins, user management, imports, search rebuild
- **EDITOR**: all content CRUD, media, taxonomies, menus, widgets, publish/unpublish
- **AUTHOR**: own content CRUD, media upload
- **CONTRIBUTOR**: own content create/edit (no publish), media upload

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
- **Database:** Tests use real in-memory SQLite via `better-sqlite3` + Kysely. No DB mocking.
- **Utilities:** `tests/utils/test-db.ts` provides `createTestDatabase()`, `setupTestDatabase()` (with migrations), and `setupTestDatabaseWithCollections()` (with standard post/page collections).
- **Structure:** `tests/unit/` for unit, `tests/integration/` for integration (real DB), `tests/e2e/` for Playwright. Test files mirror source structure.
- **Lifecycle:** Each test gets a fresh in-memory DB in `beforeEach`, destroyed in `afterEach`.

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
- **oxfmt** -- code formatting (tabs for indentation, configured in `.prettierrc`). All source files use tabs, not spaces.

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

### Exercising the TOTP login path

Add `?totp=1` to the setup-bypass URL to provision a known-seed TOTP credential on the dev user (the RFC 6238 Appendix B test vector, `12345678901234567890`). The JSON response body includes `{ totp: { secret, currentCode } }` where `currentCode` is the 6-digit code valid for the current 30-second period. Use it to drive the TOTP login flow from an agent-browser test without polling the authenticator state.

```bash
curl "http://localhost:4321/_emdash/api/setup/dev-bypass?totp=1" | jq
```

Requires `EMDASH_AUTH_SECRET` to be set (a valid 32+ char base64url string). Without it, the `?totp=1` branch silently skips provisioning so the default dev-bypass still works.

### Editing the Astro integration plugin

Routes registered via `injectRoute` in `packages/core/src/astro/integration/routes.ts` are only mounted at server startup. If you add, remove, or rename a registered route, **rebuild the core package and restart the dev server**:

```bash
pnpm --filter emdash build
# then restart pnpm dev in demos/simple
```

Vite HMR reloads Astro route files but NOT the integration plugin itself. A stale plugin will keep serving the old route table until the process is restarted, which surfaces as confusing 404s on routes you just added.
