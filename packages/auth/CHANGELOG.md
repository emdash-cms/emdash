# @emdash-cms/auth

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.1

## 0.16.0

## 0.15.0

### Minor Changes

- [#1146](https://github.com/emdash-cms/emdash/pull/1146) [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b) Thanks [@MohamedH1998](https://github.com/MohamedH1998)! - Adds first-class i18n support for bylines, mirroring the row-per-locale model already used by menus and taxonomies (PR #916, migrations 036).

  ## Schema (migration 040)

  `_emdash_bylines` gains two columns:
  - `locale` — `TEXT NOT NULL DEFAULT 'en'`. Every row now belongs to exactly one locale.
  - `translation_group` — `TEXT NOT NULL`. Shared across every locale variant of a single byline identity. The anchor row's `translation_group` equals its `id`; siblings inherit it.

  A partial unique index `idx_bylines_group_locale_unique` enforces one row per `(translation_group, locale)`. The pre-existing `(slug)` unique index becomes `(slug, locale)` to allow the same slug across locales.

  Existing rows are backfilled to the configured `defaultLocale` (or `'en'` if i18n isn't configured) with `translation_group = id`. Monolingual sites see no functional change; multilingual sites continue rendering the same byline data at the default locale until editors create translations.

  ## Credit hydration: strict per-locale

  `_emdash_content_bylines.byline_id` now stores the byline's `translation_group`, not its row id. When an entry is rendered, credits are filtered by joining the junction against the byline sibling whose `locale` matches the entry's `locale`. If no sibling exists at the entry's locale, the credit hydrates as empty — there is **no fallback** to other locales' bios.

  Author-inferred bylines (where an entry has no explicit credits but its author is linked to a byline) still fall back per-locale and respect the strictness gate: an entry with explicit credits at any locale will not infer from the author even if the explicit credits don't resolve at the rendering locale.

  This is a deliberate behavior change for multilingual sites. The motivation is correctness: chain-walking credits across locales renders the wrong-language bio on translated entries.

  The "explicit credit suppresses author fallback" check reads `primary_byline_id` directly from the content row — set by `setContentBylines` iff junction rows exist, backfilled by migration 040 for pre-existing rows. No separate probe against `_emdash_content_bylines` is needed at hydration time; the column is folded into the single per-entry context fetch (`author_id` + `primary_byline_id` in one query). Both monolingual and multilingual sites get the same query count.

  ## Identity lookups: chain-walk

  `getBylineBySlug(slug, { locale })` walks the configured fallback chain (`resolveLocaleChain`), like `getMenu` and `getTerm`. Author pages for un-translated bylines still render an identity rather than 404'ing. This is conceptually distinct from credit hydration and runs through `requestCached` for per-render dedupe.

  ## Admin
  - **TranslationsPanel** in the bylines editor lists every configured locale with Edit / Translate buttons. The Translate action POSTs to the new `POST /_emdash/api/admin/bylines/:id/translations` endpoint.
  - **LocaleSwitcher** on `/bylines` filters the list strictly to one locale. Cross-locale navigation via TranslationsPanel routes through `/bylines?locale=…`.
  - The **byline picker** on the content editor is locale-pinned to the entry's locale. Editors only see bylines that will actually hydrate at the entry's locale.
  - The **byline credit empty state** on a locale with no bylines yet shows a CTA linking to `/bylines?locale=…` for inline creation.
  - Translating an entry (`POST /content/:collection` with `translationOf`) calls `copyContentBylines` to inherit the source's credits — these resolve at the new entry's locale via the strict-hydration model, so credits "follow" the content across translations once sibling bylines exist.

  ## API additions
  - `GET /_emdash/api/admin/bylines/:id/translations` — list every sibling row sharing a translation_group.
  - `POST /_emdash/api/admin/bylines/:id/translations` — create a sibling at a target locale. Body defaults (slug, displayName, websiteUrl, avatar) inherit from the source.
  - `POST /_emdash/api/admin/bylines` accepts `translationOf` + `locale` to create a sibling in one call.
  - `GET /_emdash/api/admin/bylines?locale=…` filters strictly.
  - `BylineSummary` gains `locale: string` and `translationGroup: string | null` (additive — existing consumers ignore the new fields).

  ## Permissions

  Two new entries on `@emdash-cms/auth`:
  - `bylines:read` — minimum `SUBSCRIBER`.
  - `bylines:manage` — minimum `EDITOR`.

  All byline routes (list, get, update, delete, translations) now check these instead of `content:read` / `Role.EDITOR`. Role thresholds are unchanged, so existing users see no permission differences. Custom RBAC configurations that bind to the old strings should add the new permission names.

  ## Repository
  - `BylineRepository` is strict per-locale: `findMany`, `findBySlug`, `findById` accept an optional `locale` and return rows matching that locale (or all locales when omitted, for the manager view).
  - New methods: `listTranslations(id)`, `findByTranslationGroup(group)`, `copyContentBylines(collection, fromId, toId)`.
  - `setContentBylines` deduplicates by `translation_group` after resolving wire row ids, so passing two sibling row ids of the same identity collapses to one credit row.
  - `delete` is sibling-aware: removing one locale variant leaves siblings standing.

  ## Notable trade-offs
  - **Strict hydration over chain-walking** for credits. Chain-walking would render mismatched-language bios on translated content. The honest answer is to show nothing rather than the wrong thing; the picker tells editors which bylines will resolve at the entry's locale, and the empty-state CTA makes creating a sibling a one-click flow.
  - **Schema is row-per-locale**, not a separate `byline_translations` side-table. Matches the existing content / menu / taxonomy convention so query patterns and indexes are consistent across the codebase.

### Patch Changes

- [#1139](https://github.com/emdash-cms/emdash/pull/1139) [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Upgrades `kysely` to `^0.29.0` (was `^0.27.0`) to resolve three high-severity advisories fixed in `>=0.28.17`:
  - GHSA-wmrf-hv6w-mr66 – SQL injection via unsanitized JSON path keys
  - GHSA-pv5w-4p9q-p3v2 – JSON-path traversal injection via `JSONPathBuilder.key()` / `.at()`
  - GHSA-8cpq-38p9-67gx – MySQL SQL injection via `sql.lit(string)`

  Also updates import paths for `Migrator` and `Migration` types to `kysely/migration` to comply with kysely 0.29 export changes.

## 0.14.0

## 0.13.0

### Patch Changes

- [#1019](https://github.com/emdash-cms/emdash/pull/1019) [`5681eb2`](https://github.com/emdash-cms/emdash/commit/5681eb2e43fbe57c535e5f828c1c8eba06b3eb89) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a Zod type-incompatibility between trusted plugins and core. Without a workspace-level pin, emdash's `zod: ^4.3.5` could resolve to a different patch than Astro's bundled Zod, and Zod 4 embeds the version in the type — so schemas imported via `astro/zod` in trusted plugins (e.g. `@emdash-cms/plugin-forms`) were not assignable to `definePlugin`'s `PluginRoute<TInput>['input']`. Pins Zod in the pnpm catalog so the entire workspace dedupes on one instance.

## 0.12.0

## 0.11.1

## 0.11.0

### Patch Changes

- [#893](https://github.com/emdash-cms/emdash/pull/893) [`f8ee1ed`](https://github.com/emdash-cms/emdash/commit/f8ee1ed5e7b02b8905ebec82fb703e3061fe8161) Thanks [@j-liszt](https://github.com/j-liszt)! - Enhances Passkey authentication with polymorphic algorithm support. Adds support for RS256 (RSA) alongside the existing ES256 (ECDSA) implementation, ensuring full compatibility with Windows Hello, hardware security keys, and FIDO2 standards. Includes a database migration to track and persist credential algorithms for future-proof authentication.

  Note for standalone `@emdash-cms/auth` consumers: If your `credentials` table already exists, you must manually run `ALTER TABLE credentials ADD COLUMN algorithm INTEGER NOT NULL DEFAULT -7` to support this update. The `DEFAULT -7` value ensures that existing rows (which are all ES256) continue to work seamlessly without requiring any data backfill.

## 0.10.0

### Patch Changes

- [#912](https://github.com/emdash-cms/emdash/pull/912) [`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31) Thanks [@lsngmin](https://github.com/lsngmin)! - Permanent-delete API now refuses to remove live (non-trashed) rows and uses a content-domain `content:delete_permanent` permission instead of the unrelated `import:execute`. Existing audience (ADMIN-only) is unchanged.

## 0.9.0

### Minor Changes

- [#800](https://github.com/emdash-cms/emdash/pull/800) [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b) Thanks [@csfalcao](https://github.com/csfalcao)! - Adds support for accepting passkey assertions from multiple origins that share an `rpId`, for deployments reachable under several hostnames (apex + preview/staging) under one registrable parent. Declare additional origins via `EmDashConfig.allowedOrigins` (in `astro.config.mjs`) or the `EMDASH_ALLOWED_ORIGINS` env var (comma-separated); the two sources merge at runtime. EmDash validates the merged set against `siteUrl` and rejects dead config (non-subdomain entries, IP-literal `siteUrl`, trailing dots, empty labels) with source-attributed errors. `PasskeyConfig.origin: string` is replaced by `PasskeyConfig.origins: string[]`.

## 0.8.0

### Minor Changes

- [#779](https://github.com/emdash-cms/emdash/pull/779) [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `settings_get` and `settings_update` MCP tools so agents can read and update site-wide settings (title, tagline, logo, favicon, URL, posts-per-page, date format, timezone, social, SEO). `settings_get` resolves media references (logo/favicon/seo.defaultOgImage) to URLs; `settings_update` is a partial update that preserves omitted fields. New `settings:read` (EDITOR+) and `settings:manage` (ADMIN) API token scopes back the tools, with matching options in the personal API token settings UI.

### Patch Changes

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

- [#777](https://github.com/emdash-cms/emdash/pull/777) [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `taxonomies:manage` and `menus:manage` API token scopes for fine-grained control over taxonomy and menu mutations via MCP and REST. Existing tokens with `content:write` continue to work for those operations: `content:write` now implicitly grants `menus:manage` and `taxonomies:manage` so PATs issued before the split keep their effective permissions. The reverse implication does not hold — a token with only `menus:manage` cannot create or edit content.

## 0.7.0

### Patch Changes

- [#736](https://github.com/emdash-cms/emdash/pull/736) [`81fe93b`](https://github.com/emdash-cms/emdash/commit/81fe93bc675581ddd0161eaabbe7a3471ec76529) Thanks [@ascorbic](https://github.com/ascorbic)! - Restricts Subscriber-role access to draft, scheduled, and trashed content. Subscribers retain `content:read` for member-only published content but no longer see non-published items via the REST API or MCP server. Adds a new `content:read_drafts` permission (Contributor and above) that gates `/compare`, `/revisions`, `/trash`, `/preview-url`, and the corresponding MCP tools.

## 0.6.0

### Patch Changes

- [#552](https://github.com/emdash-cms/emdash/pull/552) [`f52154d`](https://github.com/emdash-cms/emdash/commit/f52154da8afb838b1af6deccf33b5a261257ec7c) Thanks [@masonjames](https://github.com/masonjames)! - Fixes passkey login failures so unregistered or invalid credentials return an authentication failure instead of an internal server error.

## 0.5.0

### Patch Changes

- [#542](https://github.com/emdash-cms/emdash/pull/542) [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001) Thanks [@mohamedmostafa58](https://github.com/mohamedmostafa58)! - Fixes invite flow: corrects invite URL to point to admin UI page, adds InviteAcceptPage for passkey registration.

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- [#452](https://github.com/emdash-cms/emdash/pull/452) [`1a93d51`](https://github.com/emdash-cms/emdash/commit/1a93d51777afaec239641e7587d6e32d8a590656) Thanks [@kamine81](https://github.com/kamine81)! - Fixes GitHub OAuth login failing with 403 on accounts where email is private. GitHub's API requires a `User-Agent` header and rejects requests without it.

## 0.1.1

### Patch Changes

- [#133](https://github.com/emdash-cms/emdash/pull/133) [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063) Thanks [@kyjus25](https://github.com/kyjus25)! - Fix auth links and OAuth callbacks to use `/_emdash/api/auth/...` so emailed sign-in, signup, and invite URLs resolve correctly in EmDash.

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
