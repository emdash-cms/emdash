---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Adds first-class i18n support for bylines, mirroring the row-per-locale model already used by menus and taxonomies (PR #916, migrations 036).

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
