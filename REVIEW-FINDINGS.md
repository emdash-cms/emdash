# Emdash Code Quality Review — Findings

Comprehensive review of all 9 packages (~141K LOC). Eight review agents, each reading every file in their scope. Findings organized by severity.

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 12    |
| Medium   | 35    |
| Low      | 30    |
| Nit      | 10    |

No showstoppers. The codebase works and the architecture is sound. What follows is everything worth fixing, from correctness bugs to performance opportunities to pattern inconsistencies.

---

## 1. Critical

None found.

---

## 2. High

### H1. Optimistic concurrency check is outside the transaction

**File:** `packages/core/src/api/handlers/content.ts:500-523`
**Agent:** 1 (API Layer)

`handleContentUpdate` validates `_rev` (optimistic concurrency) before entering the transaction. The `findById` at line 508 and the `update` inside `withTransaction` at line 539 are not atomic. A concurrent write between the rev check and the update succeeds, defeating the purpose.

```typescript
if (body._rev) {
    const existing = await repo.findById(collection, resolvedId);  // OUTSIDE transaction
    const revCheck = validateRev(body._rev, existing);
}
const item = await withTransaction(db, async (trx) => {
    // ... actual update happens here
```

**Fix:** Move the rev check inside the transaction, or add a WHERE clause to the update that includes the version.

---

### H2. `dialect-helpers.ts` jsonExtractExpr() — raw string interpolation

**File:** `packages/core/src/database/dialect-helpers.ts:133-138`
**Agent:** 2 (Database)

Both `column` and `path` are interpolated raw into SQL strings. AGENTS.md explicitly warns about this pattern.

```typescript
export function jsonExtractExpr(db: Kysely<any>, column: string, path: string): string {
	if (isPostgres(db)) {
		return `${column}->>'${path}'`;
	}
	return `json_extract(${column}, '$.${path}')`;
}
```

If `path` contains a single quote, it breaks out of the SQL string. Callers currently validate, but the function provides no safety.

**Fix:** Add `validateIdentifier()` or `validateJsonFieldName()` inside the function.

---

### H3. Content repository — data keys used as column names without validation

**File:** `packages/core/src/database/repositories/content.ts:140-184`
**Agent:** 2 (Database)

`create()` and `update()` pass user-supplied `data` keys directly to SQL operations. The SYSTEM_COLUMNS filter prevents overwriting system columns but doesn't validate that remaining keys are legitimate identifiers. Defense relies on schema registry having validated field slugs at creation time, but the content repository doesn't verify data keys match registered fields.

**Fix:** Validate data keys against registered fields, or run `validateIdentifier()` on each key.

---

### H4. Migration 011 `down()` drops indexes from wrong migration

**File:** `packages/core/src/database/migrations/011_sections.ts:61-64`
**Agent:** 2 (Database)

The `down()` drops `idx_content_taxonomies_term` and `idx_media_mime_type`, which belong to migration `015_indexes.ts`. Rolling back 011 destroys indexes that should only be removed by rolling back 015.

**Fix:** Only drop `idx_sections_category`, `idx_sections_source`, `_emdash_sections`, and `_emdash_section_categories`.

---

### H5. Plugin `createMediaAccessWithWrite.upload()` returns wrong mediaId

**File:** `packages/core/src/plugins/context.ts:431-478`
**Agent:** 3 (Plugins)

`mediaId` is generated via `ulid()` at line 442, but `mediaRepo.create()` at line 458 doesn't receive it — the repository generates its own ID. The returned `mediaId` doesn't match the database record.

**Fix:** Pass `id: mediaId` to `mediaRepo.create()`, or return the repository's generated ID.

---

### H6. MCP taxonomy tools bypass type safety with `as never` casts

**File:** `packages/core/src/mcp/server.ts:1180-1310`
**Agent:** 3 (Plugins)

`taxonomy_list`, `taxonomy_list_terms`, and `taxonomy_create_term` use raw Kysely queries with `as never` casts, bypassing type safety. `taxonomy_create_term` directly inserts into the database, bypassing the repository layer — no slug validation, no duplicate check, no parent existence check.

**Fix:** Use the TaxonomyRepository instead of raw queries. Remove `as never` casts.

---

### H7. Admin router.tsx — 1675 lines with 11 inline mutations per page

**File:** `packages/admin/src/router.tsx`
**Agent:** 5 (Admin UI)

The router contains all page components inline with full query/mutation logic. `ContentEditPage` alone (lines 505-901) defines 11 separate mutations. `ROLE_EDITOR = 40` is duplicated in router.tsx, AdminCommandPalette.tsx, Sidebar.tsx, and ContentEditor.tsx with no single source of truth.

**Fix:** Extract page components to `routes/` files. Extract shared mutation patterns into custom hooks. Create `lib/roles.ts` for role constants.

---

### H8. Admin App.tsx — module-level singletons

**File:** `packages/admin/src/App.tsx:24-34`
**Agent:** 5 (Admin UI)

`queryClient` and `router` are created at module scope. If `AdminApp` is ever rendered in multiple contexts (testing, SSR), they share state.

**Fix:** Create inside component or via `useRef`.

---

### H9. Zod v3/v4 split between marketplace and core

**File:** `packages/marketplace/package.json:18`
**Agent:** 7 (Cross-cutting)

Marketplace uses Zod v3 (`^3.25.67`) while core and auth use Zod v4 (`^4.3.5`). Zod v3 and v4 have incompatible APIs. If any schemas are ever shared between packages, this causes runtime errors.

**Fix:** Upgrade marketplace to Zod v4. Add `zod` to pnpm catalog.

---

### H10. Byline hydration runs on every query — even when no bylines exist

**File:** `packages/core/src/query.ts:317,394`
**Agent:** 8 (Performance)

Every content query triggers `hydrateEntryBylines()` which runs 1-3 additional DB queries. Most sites don't use bylines. For a collection page with 10 posts, this adds 1-3 queries that return empty results.

**Fix:** Make byline hydration opt-in via query option, or cache a per-collection "has any bylines" check at worker level.

---

### H11. `resolveEmDashPath` fetches ALL collections on every call

**File:** `packages/core/src/query.ts:662-691`
**Agent:** 8 (Performance)

Creates a `SchemaRegistry`, queries all collections, compiles URL pattern regexes, and tests each against the path — on every page load.

**Fix:** Cache collection list and compiled patterns at worker level. Invalidate on schema change.

---

### H12. Cold start blocks first visitor with full runtime init

**File:** `packages/core/src/emdash-runtime.ts:564-806`
**Agent:** 8 (Performance)

First request triggers migrations, FTS verification, plugin loading (including R2 fetches for marketplace plugins), cron initialization, email pipeline creation. All of this runs before the first logged-out visitor gets their page.

**Fix:** Defer non-essential initialization (FTS repair, cron, marketplace plugin loading) to after the first response via `waitUntil` or background task.

---

## 3. Medium

### M1. N+1 queries in taxonomy term listing

**File:** `packages/core/src/api/handlers/taxonomies.ts:263-267`
**Agent:** 1

`handleTermList` runs one `countEntriesWithTerm` per term in a sequential loop.

**Fix:** Single batch query.

---

### M2. Response shape inconsistencies — taxonomies, menus

**Files:** `packages/core/src/api/handlers/taxonomies.ts:28-54`, `packages/core/src/api/handlers/menus.ts:42`
**Agent:** 1

`TaxonomyListResponse` uses `{ taxonomies }`, `TermListResponse` uses `{ terms }`, `handleMenuList` returns a bare array. AGENTS.md says list endpoints must use `{ items, nextCursor? }`.

**Fix:** Standardize all list responses to `{ items, nextCursor? }`.

---

### M3. N+1 queries in menu listing

**File:** `packages/core/src/api/handlers/menus.ts:42-65`
**Agent:** 1

One count query per menu via `Promise.all`.

**Fix:** Single query with subquery or LEFT JOIN.

---

### M4. Menu item reorder has no transaction

**File:** `packages/core/src/api/handlers/menus.ts:467-477`
**Agent:** 1

Sequential updates without a transaction. Crash mid-loop leaves items partially reordered.

**Fix:** Wrap in `withTransaction()`.

---

### M5. `parseQuery` drops repeated query param keys

**File:** `packages/core/src/api/parse.ts:92-98`
**Agent:** 1

Only keeps the last value for each search param key. Array-valued params silently lose data.

---

### M6. Migration 014 index naming inconsistency

**File:** `packages/core/src/database/migrations/014_draft_revisions.ts:14-15`
**Agent:** 2

Uses `idx_${row.slug}_*` (collection slug) instead of `idx_${tableName}_*` (with `ec_` prefix), inconsistent with registry.ts.

---

### M7. `byline.ts` delete() uses `db.transaction()` directly

**File:** `packages/core/src/database/repositories/byline.ts:200-216`
**Agent:** 2

Uses `db.transaction().execute()` instead of `withTransaction()`. Breaks on D1 which doesn't support transactions.

**Fix:** Use `withTransaction()`.

---

### M8. Redirect search — LIKE wildcards not escaped

**File:** `packages/core/src/database/repositories/redirect.ts:138-143`
**Agent:** 2

User search terms containing `%` or `_` are interpreted as LIKE wildcards. Other repositories (media, comment) properly escape these.

**Fix:** Escape LIKE wildcards in search term.

---

### M9. `db/sqlite.ts` missing WAL mode and foreign_keys pragma

**File:** `packages/core/src/db/sqlite.ts`
**Agent:** 2

The old `connection.ts` sets WAL and foreign_keys. The new `db/sqlite.ts` adapter sets neither. Databases created via the new path won't have FK enforcement.

**Fix:** Add pragma statements to match old adapter.

---

### M10. Plugin-storage cursor uses SQLite-specific tuple comparison

**File:** `packages/core/src/database/repositories/plugin-storage.ts:233-236`
**Agent:** 2

`(created_at, id) > (?, ?)` is SQLite-specific. Rest of codebase uses cross-dialect pattern.

**Fix:** Use `eb.or([eb(col, "<", val), eb.and([...])])`.

---

### M11. Hook dependency circular references silently ignored

**File:** `packages/core/src/plugins/hooks.ts:320-341`
**Agent:** 3

When circular dependencies are detected, hooks are silently sorted by priority with no warning.

**Fix:** Log a warning with affected plugin IDs.

---

### M12. Hook timeout doesn't cancel the timed-out function

**File:** `packages/core/src/plugins/hooks.ts:346-353`
**Agent:** 3

`Promise.race` with `setTimeout` — the losing hook continues running after timeout. Resource leak on Node.js.

---

### M13. Plugin route error messages leak internal details

**File:** `packages/core/src/plugins/routes.ts:126-136`
**Agent:** 3

Non-`PluginRouteError` errors return `error.message` to client. Violates AGENTS.md: "never expose error.message to clients."

**Fix:** Log error, return generic message.

---

### M14. MCP `taxonomy_list` — unguarded JSON.parse

**File:** `packages/core/src/mcp/server.ts:1192-1197`
**Agent:** 3

`JSON.parse(row.collections)` without try/catch. Malformed JSON crashes the entire tool call.

---

### M15. Seed menu/widget application ignores `onConflict: "skip"`

**File:** `packages/core/src/seed/apply.ts:436-478, 519-556`
**Agent:** 3

Menu application always deletes all existing items and recreates them, even when `onConflict` is `"skip"`. Same for widget areas.

---

### M16. Empty paragraphs dropped in ProseMirror -> Portable Text conversion

**File:** `packages/core/src/content/converters/prosemirror-to-portable-text.ts:97-112`
**Agent:** 3

`convertParagraph` returns null for empty paragraphs. Intentional spacing paragraphs are lost in round-trip.

---

### M17. Seed content creation not transactional

**File:** `packages/core/src/seed/apply.ts:342-433`
**Agent:** 3

Content creation in the seed engine doesn't run inside a transaction. Crash mid-seed leaves partially-created content.

---

### M18. FTS5 table creation — raw interpolation in `sql.raw()`

**File:** `packages/core/src/search/fts-manager.ts:86-94`
**Agent:** 4

`content='${contentTable}'` uses string interpolation inside `sql.raw()`. Input is validated, but the pattern is fragile.

---

### M19. Search `escapeQuery` logic flaw

**File:** `packages/core/src/search/query.ts:359-395`
**Agent:** 4

Escapes double quotes, then checks the original (not escaped) query for FTS5 operators. If user passes `"hello" AND world`, the escaped version has `""hello"" AND world` — malformed FTS5.

**Fix:** Check for operators before escaping, or check the escaped string.

---

### M20. S3/Local storage buffers entire streams into memory

**File:** `packages/core/src/storage/s3.ts:64-83`
**Agent:** 4

Both `S3Storage.upload` and `LocalStorage.upload` buffer the entire `ReadableStream` before uploading. Large files cause OOM on memory-constrained runtimes.

**Fix:** Use streaming upload via `@aws-sdk/lib-storage`.

---

### M21. Comments `autoLinkUrls` runs on already-escaped HTML

**File:** `packages/core/src/components/Comments.astro:46-51`
**Agent:** 4

URL regex runs after `escapeHtml`, so URLs with `&` are escaped to `&amp;` before matching. Generated `<a href="...&amp;...">` has double-escaped ampersands.

**Fix:** Run `autoLinkUrls` on raw text first.

---

### M22. Visual editing toolbar — unvalidated JSON from DOM attributes

**File:** `packages/core/src/visual-editing/toolbar.ts:597-598`
**Agent:** 4

`JSON.parse(first.getAttribute("data-emdash-ref"))` — parsed `ref.collection` and `ref.id` used directly in API URLs without validation. Attack surface is limited to authenticated editors, but defense-in-depth is warranted.

---

### M23. Client `generateKey` counter shared across server requests

**File:** `packages/core/src/client/portable-text.ts:358-362`
**Agent:** 4

Module-level counter produces non-deterministic keys across requests. Could cause hydration mismatches.

---

### M24. Client `refreshInterceptor` — potential infinite retry loop

**File:** `packages/core/src/client/transport.ts:178-197`
**Agent:** 4

If retry also returns 401, it triggers another refresh attempt with no loop guard.

---

### M25. Menu URL resolution — no identifier validation on collection from DB

**File:** `packages/core/src/menus/index.ts:277-279`
**Agent:** 4

`sql.ref(\`ec\_${collection}\`)`where`collection`comes from stored menu item data. No`validateIdentifier` call.

---

### M26. ContentEditor autosave has stale `activeBylines` in closure

**File:** `packages/admin/src/components/ContentEditor.tsx:322-352`
**Agent:** 5

The autosave `setTimeout` callback captures `activeBylines` from the render when the timeout was scheduled. Changes during the 2-second debounce are lost.

**Fix:** Add `activeBylinesRef` matching the pattern used for `formData` and `slug`.

---

### M27. ContentEditor effect dependency list incomplete

**File:** `packages/admin/src/components/ContentEditor.tsx:286`
**Agent:** 5

Form reset effect doesn't include `item?.bylines`. Server-side byline changes won't sync.

---

### M28. Duplicated `useDebouncedValue` across 3 files

**File:** `packages/admin/src/components/AdminCommandPalette.tsx:47-61`, `packages/admin/src/routes/users.tsx:32-41`
**Agent:** 5

Two local implementations when `lib/hooks.ts` already exports the same hook.

---

### M29. Marketplace dev route gating — hostname-based, bypassable

**File:** `packages/marketplace/src/routes/dev.ts:25-31`
**Agent:** 6

Gated by `url.hostname !== "localhost"`. Bypassable via `Host` header manipulation in proxy configs.

**Fix:** Use environment variable flag or remove dev routes from production builds.

---

### M30. Marketplace tarball extraction duplicated across 3 files

**File:** `packages/marketplace/src/routes/dev.ts`, `author.ts`, `workflows/audit.ts`
**Agent:** 6

`extractTarball`, `collectStream` copy-pasted in three places.

**Fix:** Extract to shared `utils/tarball.ts`.

---

### M31. Marketplace JWT signed with GITHUB_CLIENT_SECRET

**File:** `packages/marketplace/src/routes/author.ts:738-744`
**Agent:** 6

GitHub OAuth client secret doubles as JWT signing key. Different threat model, rotation dependency.

**Fix:** Use dedicated `JWT_SECRET` environment variable.

---

### M32. Marketplace CORS allows all origins

**File:** `packages/marketplace/src/app.ts:18-25`
**Agent:** 6

`cors({ origin: "*" })` with `Authorization` in allowHeaders.

---

### M33. Auth invite URL not HTML-escaped in email templates

**File:** `packages/auth/src/invite.ts:97`, `signup.ts:114`, `magic-link/index.ts:86`
**Agent:** 6

URLs interpolated into `href` attributes without HTML escaping. `siteName` is escaped but URLs are not.

---

### M34. Divergent TypeScript configs across packages

**File:** Various `tsconfig.json` files
**Agent:** 7

`verbatimModuleSyntax` (documented as enforced in AGENTS.md) only present in ~5 of ~40 tsconfigs. Core package explicitly disables `noUncheckedIndexedAccess`. Target varies (es2022 vs es2023).

**Fix:** Consolidate to single base config. All packages extend it.

---

### M35. Redirect pattern rules not cached — fetched on every request

**File:** `packages/core/src/redirects/`, `packages/core/src/astro/middleware/redirect.ts`
**Agent:** 8

`findEnabledPatternRules()` queries all pattern rules from DB and compiles regexes on every request. Rules change rarely.

**Fix:** Cache at worker level with invalidation on write.

---

## 4. Low

### L1. `handleContentListTrashed` — `deletedAt` typed as non-nullable string

`packages/core/src/api/handlers/content.ts:840-851` (Agent 1)

### L2. Device flow linear scan of all pending codes

`packages/core/src/api/handlers/device-flow.ts:397-407` (Agent 1) — Fetches ALL pending codes, linear scan to match.

### L3. `handleContentSchedule` — SEO hydration outside transaction

`packages/core/src/api/handlers/content.ts:897-936` (Agent 1)

### L4. Middleware auth uses inline `new Response(JSON.stringify(...))` ~6 times

`packages/core/src/astro/middleware/auth.ts:141-153,204-210,178-181,574-577,698-700,714-721` (Agent 1) — Should use `apiError()`.

### L5. Migration 007 and 011 use raw `CURRENT_TIMESTAMP` instead of `currentTimestamp(db)`

`packages/core/src/database/migrations/007_widgets.ts:11,28`, `011_sections.ts:18,41-42` (Agent 2)

### L6. Missing index on `media.author_id`

`packages/core/src/database/migrations/001_initial.ts` (Agent 2)

### L7. Missing index on `auth_tokens.user_id`

`packages/core/src/database/migrations/008_auth.ts` (Agent 2)

### L8. `redirect.ts` delete — `BigInt(undefined)` risk

`packages/core/src/database/repositories/redirect.ts:237,465` (Agent 2)

### L9. Content repository `getTableName()` — no identifier validation

`packages/core/src/database/repositories/content.ts:43-45` (Agent 2)

### L10. Schema registry `reorderFields()` — unchecked index access

`packages/core/src/schema/registry.ts:500-507` (Agent 2)

### L11. Plugin cron — no retry limit on failed one-shot tasks

`packages/core/src/plugins/cron.ts:114-122` (Agent 3) — Fixed 1-minute retry forever.

### L12. Plugin `isHostAllowed` — wildcard `*.example.com` matches bare `example.com`

`packages/core/src/plugins/context.ts:494-503` (Agent 3) — Undocumented behavior.

### L13. Link mark dedup key doesn't include `target`

`packages/core/src/content/converters/prosemirror-to-portable-text.ts:389-407` (Agent 3)

### L14. Import SSRF — DNS rebinding not mitigated

`packages/core/src/import/ssrf.ts:162-165` (Agent 3) — Known limitation, documented in code.

### L15. Import `setOption` uses raw table query instead of repository

`packages/core/src/import/settings.ts:200-223` (Agent 3)

### L16. Plugin marketplace download uses `redirect: "follow"`

`packages/core/src/plugins/marketplace.ts:241-271` (Agent 3) — Inconsistent with security posture elsewhere.

### L17. S3 list uses non-null assertion on `item.Key`

`packages/core/src/storage/s3.ts:182-185` (Agent 4)

### L18. Rate limit IP regex is very loose

`packages/core/src/auth/rate-limit.ts:19` (Agent 4)

### L19. Local media delete order risks orphaned records

`packages/core/src/media/local-runtime.ts:109-123` (Agent 4) — Deletes storage before DB.

### L20. Sections search doesn't escape LIKE wildcards

`packages/core/src/sections/index.ts:126-135` (Agent 4)

### L21. Toolbar `escapeAttr` doesn't escape single quotes

`packages/core/src/visual-editing/toolbar.ts:1018-1019` (Agent 4)

### L22. Taxonomies `JSON.parse(row.collections)` not type-validated

`packages/core/src/taxonomies/index.ts:24,48` (Agent 4)

### L23. `_navigate` unused variable in ContentTypeEditor

`packages/admin/src/components/ContentTypeEditor.tsx:136` (Agent 5)

### L24. StatusBadge uses hardcoded Tailwind colors instead of kumo tokens

`packages/admin/src/components/ContentList.tsx:533-547` (Agent 5)

### L25. MediaLibrary `onSelect` prop declared but never used

`packages/admin/src/components/MediaLibrary.tsx:22` (Agent 5)

### L26. LoginPage empty dependency array missing `t` function

`packages/admin/src/components/auth/LoginPage.tsx:257` (Agent 5)

### L27. Cloudflare `initializedSessions` Set grows unbounded

`packages/cloudflare/src/db/playground-middleware.ts:50` (Agent 6)

### L28. x402 `_initPromise` doesn't reset on failure

`packages/x402/src/enforcer.ts:30-31` (Agent 6)

### L29. CI release uses Node 24, tests use Node 22

`.github/workflows/release.yml:46` vs `ci.yml` (Agent 7)

### L30. Auth `error.ts` and `errors.ts` — confusingly similar names

`packages/core/src/api/error.ts`, `packages/core/src/api/errors.ts` (Agent 7)

---

## 5. Nit

### N1. AGENTS.md authorization section should be updated to reflect permission-based pattern

Agent 1 — Routes use `requirePerm()` but AGENTS.md documents old `requireRole()` pattern.

### N2. Comment repository `rowToComment` uses `any` type

`packages/core/src/database/repositories/comment.ts:440` (Agent 2)

### N3. Seed step numbering off (two step 11s)

`packages/core/src/seed/apply.ts:558,619` (Agent 3)

### N4. MCP server version hardcoded as "0.1.0"

`packages/core/src/mcp/server.ts:197` (Agent 3)

### N5. Import registry module-level mutable state — test contamination risk

`packages/core/src/import/registry.ts:14` (Agent 3)

### N6. router.tsx `requestIdleCallback` polyfill mutates window at import time

`packages/admin/src/router.tsx:168-172` (Agent 5)

### N7. PasskeyLogin and PasskeyRegistration duplicate base64url utilities

`packages/admin/src/components/auth/` (Agent 5)

### N8. Gutenberg converter global regexes not reset on error

`packages/gutenberg-to-portable-text/src/index.ts:22-31`, `transformers/core.ts:22-31` (Agent 6)

### N9. Empty `peerDependencies` and `optionalDependencies` in gutenberg package

`packages/gutenberg-to-portable-text/package.json` (Agent 7)

### N10. Dead knip config references non-existent `packages/sandbox-cloudflare`

`knip.json:22` (Agent 7)

---

## 6. Performance Summary (Agent 8)

### Logged-Out Request — Operations Table

| Operation                      | Queries | Allocations                              | Can be eliminated/deferred?                                          |
| ------------------------------ | ------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Runtime init (cold)            | ~8+     | Runtime, registries, managers, pipelines | Defer non-essential (FTS, cron, marketplace) to after first response |
| Runtime init (warm)            | 0       | 2 (page metadata/fragment callbacks)     | Skip if no plugins register page hooks                               |
| Setup probe (cold)             | 1       | 0                                        | One-time, acceptable                                                 |
| Redirect check                 | 1-2     | RedirectRepository, compiled patterns    | Cache pattern rules at worker level                                  |
| Auth (public)                  | 0-1     | 0                                        | Acceptable                                                           |
| Request context                | 0       | 0                                        | Already optimized                                                    |
| Content query                  | 1       | Dynamic import promise, entries array    | Hoist static imports                                                 |
| Byline hydration               | 1-3     | BylineRepository, Map, dynamic import    | Make opt-in or cache "has bylines" check                             |
| mapRowToData                   | 0       | Object per row, JSON.parse attempts      | Support column selection to avoid unnecessary parsing                |
| resolveEmDashPath              | 1-2     | SchemaRegistry, regex compilations       | Cache collection patterns at worker level                            |
| **TOTAL (warm, single entry)** | **3-6** | **~10**                                  | **Reducible to 1-2 queries**                                         |

### Performance Improvements — Ranked by Impact

1. **Cache `resolveEmDashPath` collection patterns** (H11) — eliminates 1 query + N regex compilations per page
2. **Make byline hydration opt-in or lazy** (H10) — eliminates 1-3 queries per page for most sites
3. **Cache redirect pattern rules** (M35) — eliminates 1 unbounded query per request
4. **Hoist dynamic imports to static imports** — eliminates 4+ microtask/promise allocations per page
5. **Support column selection in loader** — reduces data transfer 10-100x for index pages
6. **Defer non-essential runtime init** (H12) — reduces cold start from seconds to milliseconds
7. **With all above applied:** warm logged-out request goes from 3-6 queries to 1-2 queries

---

## Open PR Coverage

Checked diffs (not just titles) of all 39 open PRs against these findings. Nearly everything is unaddressed.

### Addressed

| Finding                                         | PR   | Status                                                                                                                          |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| H12 (cold start blocks first visitor)           | #378 | **Fixed.** Lazy migration wrapper, init cache, FTS skip. Reduces cold-start queries from ~20 to ~2.                             |
| H11 (resolveEmDashPath fetches all collections) | #378 | **Partially.** Manifest cached in DB (1 query instead of N+1), but `resolveEmDashPath` itself still rebuilds patterns per call. |

### Not addressed (verified by diff inspection)

| Finding                                | PR that looked relevant | Why it doesn't fix it                                                                                                                                                               |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2 (jsonExtractExpr raw interpolation) | #310                    | Only changes `db` param type from `Kysely<any>` to `Kysely<Database>`. The raw `${column}` and `${path}` interpolation is unchanged.                                                |
| H3 (data keys as column names)         | #310                    | Improves cursor pagination with `sql.ref()`, but `create()`/`update()` still pass unvalidated data keys.                                                                            |
| M26 (stale activeBylines in autosave)  | #302, #272, #283        | All three fix the form-reset-on-autosave problem (remove `invalidateQueries`), but none add a `bylinesRef` -- `activeBylines` is still captured directly in the setTimeout closure. |
| M27 (missing bylines in effect deps)   | #302, #272, #283        | Effect dependency array unchanged in all three PRs.                                                                                                                                 |

### Note on competing autosave PRs

PRs #302, #272, and #283 all target the same autosave/form-reset bug with different approaches. #283 is the most comprehensive (adds `autosave-cache.ts`, revision-aware autosave). These should be consolidated before merge. None of them fix M26 or M27.

### Summary

- **1 finding fully fixed** by open PRs (H12)
- **1 finding partially fixed** (H11)
- **85 findings unaddressed** (11 high, 34 medium, 30 low, 10 nit)

---

## PR Grouping Plan

Findings cluster into themed PRs. Ordered by priority (correctness first, then performance, then quality).

### PR 1: SQL safety

**Findings:** H2, H3, M18, M25, L9

- Add `validateIdentifier()` / `validateJsonFieldName()` guards inside `jsonExtractExpr()`
- Validate data keys against registered fields in content repo `create()`/`update()`
- Validate collection identifier in menu URL resolution
- Validate FTS table name in `fts-manager.ts`

### PR 2: Transaction correctness

**Findings:** H1, M4, M7, M17

- Move `_rev` check inside the transaction in `handleContentUpdate`
- Wrap menu item reorder in `withTransaction()`
- Change `byline.ts` `delete()` from `db.transaction()` to `withTransaction()`
- Wrap seed content creation in a transaction

### PR 3: Correctness bugs

**Findings:** H4, H5, H6, M14, M19

- Fix migration 011 `down()` to only drop its own indexes
- Fix `createMediaAccessWithWrite.upload()` to pass `id: mediaId` to repo
- Rewrite MCP taxonomy tools to use TaxonomyRepository
- Add try/catch around `JSON.parse(row.collections)` in MCP
- Fix `escapeQuery` operator check order

### PR 4: Performance — hot path (non-breaking)

**Findings:** H10, H11 (remainder), M35

All three changes are invisible to consumers. No API or template changes needed.

**H10 — Byline hydration (two-part fix):**

1. **Batch queries.** `getBylinesForEntries` currently runs 1-3 separate queries. Rewrite as a single JOIN query that gets all byline data for a batch of entries in one round-trip. Always a win, no behavioral change.
2. **Cache "has any bylines" check.** On first query, `SELECT 1 FROM _emdash_bylines LIMIT 1`. Cache the boolean at worker level. When false, skip hydration and set `entry.bylines = []` — consumer still gets an array, just without the DB round-trip. Invalidate when a byline is created/updated/deleted. Sites without bylines pay zero after the first request. Sites with bylines pay 1 query (batched) instead of 1-3.

**H11 — `resolveEmDashPath` patterns:**
Derive URL patterns from the cached manifest (which PR #378 already caches in DB). Store compiled regexes on the runtime singleton. Invalidate alongside `invalidateManifest()`. Same results, just cached. Zero behavioral change.

**M35 — Redirect pattern rules:**
Cache `findEnabledPatternRules()` at worker level, including compiled regexes. Invalidate when any redirect is created/updated/deleted (add invalidation call in redirect repository write methods or expose `invalidateRedirectCache()` called from route handlers). Same results, just cached.

**Impact:** Warm logged-out request goes from 3-6 queries to 1-2. `entry.bylines` always populated (empty array when none exist). No template changes.

(H12 already addressed by open PR #378.)

### PR 5: Plugin safety

**Findings:** M11, M12, M13, L11, L12, L16

- Log warning on circular hook dependencies
- Add cancellation or resource tracking for timed-out hooks
- Return generic error message from plugin routes (don't leak internals)
- Add retry limit to failed one-shot cron tasks
- Document wildcard host matching behavior
- Use `redirect: "manual"` in marketplace plugin download

### PR 6: Admin — autosave + editor fixes

**Findings:** M26, M27, M28

- Add `activeBylinesRef` to fix stale closure in autosave
- Add `item?.bylines` to form reset effect dependencies
- Replace duplicated `useDebouncedValue` with shared hook from `lib/hooks.ts`
- (Coordinate with open PRs #302/#272/#283 — one of those should land first, then layer these fixes on top)

### PR 7: Response shape consistency

**Findings:** M2, M3

- Standardize taxonomy/menu list responses to `{ items, nextCursor? }`
- Replace N+1 count queries with batch queries

### PR 8: LIKE wildcard escaping

**Findings:** M8, L20

- Escape `%` and `_` in search terms for redirect and section searches
- Match the pattern already used in media and comment repositories

### PR 9: Cross-package hygiene

**Findings:** H9, M34

- Upgrade marketplace to Zod v4, add `zod` to pnpm catalog
- Consolidate tsconfigs to single base, ensure `verbatimModuleSyntax` everywhere

### PR 10: Auth email template safety

**Findings:** M33

- HTML-escape URLs in invite, signup, and magic link email templates

### Later / as-needed

- **Admin decomposition** (H7, H8) — router extraction and singleton fix are large refactors, better as dedicated efforts
- **Marketplace cleanup** (M29, M30, M31, M32) — dev route gating, tarball dedup, JWT key, CORS. Lower priority since marketplace is internal.
- **Seed onConflict semantics** (M15) — menu/widget skip behavior. Needs design decision on correct semantics.
- **Storage streaming** (M20) — S3/Local upload buffering. Needs testing with large files on Workers.
- **Low + nit findings** (L1-L30, N1-N10) — batch into a cleanup PR after the above land
