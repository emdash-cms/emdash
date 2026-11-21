---
title: Translate widget areas per locale
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: Kevin Kyburz (@swissky)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4676
created: 2026-11-05
---

# Translate widget areas per locale

## Summary

Give widget areas the per-locale model that menus already have. Each widget area row gets a `locale` and a `translation_group`, and `(name, locale)` replaces `name` as the unique key. Widgets keep belonging to one area row, so a translated area has its own widgets with their own titles, rich text, menu names and component props. `getWidgetArea()` and `<WidgetArea>` pick the area for the page's locale and fall back along the configured fallback chain, the way `getMenu()` does. Sites without i18n see no change.

## Problem and user case

On a multilingual site, every visitor sees the same widgets. `_emdash_widgets.title` and `_emdash_widgets.content` hold one value each, and `getWidgetArea(name)` looks an area up by name only. A sidebar titled "Recent posts" stays English on `/fr/`, and a rich-text footer widget with an address and opening hours can't be translated at all.

Issue #2696 reports this from a multilingual client-site starter. The reporter works around it with a wrapper component that rewrites titles from a plugin-managed map before `<WidgetArea>` renders. That relies on `getWidgetArea()` returning the same object instance within a request, which is an implementation detail, and it doesn't cover rich-text content.

The data the widgets show is already localized. Since #4604 the Categories, Tags, Recent Posts and Archives widgets query the page's locale, and menus have had locale rows since migration 036. The widget area is the last piece of site chrome without a locale.

## Example

A site has `en` (default) and `fr`. The `sidebar` area exists in English with two widgets:

| Locale | Widget                        | Title        | Content                  |
| ------ | ----------------------------- | ------------ | ------------------------ |
| `en`   | content                       | About us     | "We are a small museum…" |
| `en`   | component `core:recent-posts` | Recent posts |                          |

An editor opens Widgets in the admin, switches the locale to French and chooses **Translate**. EmDash creates a `sidebar` area row for `fr` in the same translation group and copies both widgets into it. The editor changes the titles to "À propos" and "Articles récents" and translates the rich text.

```astro
---
import { WidgetArea } from "emdash/ui";
---

<WidgetArea name="sidebar" />
```

On `/fr/…` this renders the French widgets. On `/de/…`, where no German area exists and the fallback chain is `de → en`, it renders the English widgets. On a site without i18n it renders the only area, as today.

`getWidgetArea("sidebar", { locale: "fr" })` returns the French area, including its `locale` and `translationGroup`.

## Goals

- Editors can create, edit, reorder and delete a widget area's widgets per locale.
- Public rendering picks the page's locale and follows the same fallback chain as menus.
- Existing sites keep their areas and widgets unchanged, as the default locale's rows.
- Logged-out page renders gain no query, including on cold start.
- Seeds, `emdash export-seed`, site transfer and snapshots keep every locale's areas.

## Non-goals

- Translating individual widget fields while sharing one widget list across locales. See [Alternatives](#alternatives).
- Machine translation or translation state tracking. The translation-state RFC (#4609) can cover widget areas later.
- MCP tools for widgets. There are none today, and this RFC doesn't add any.
- Adding Astro's locale prefix to links in the built-in menu widget renderer. The widgets guide already documents how to render localized menu links.

## Detailed design

### Data model

`_emdash_widget_areas` gains two columns, matching what migration 036 added to `_emdash_menus`:

- `locale text not null`, defaulting to the configured `defaultLocale` (or `en`);
- `translation_group text`, set to the row's own `id` for existing rows.

The unique constraint on `name` becomes `UNIQUE(name, locale)`. New indexes `idx__emdash_widget_areas_locale` and `idx__emdash_widget_areas_translation_group` follow the 036 naming.

`_emdash_widgets` keeps its columns. A widget belongs to exactly one area row, so it belongs to exactly one locale. On SQLite and D1 its foreign key to `_emdash_widget_areas` is removed during the migration (see [Compatibility and migration](#compatibility-and-migration)); PostgreSQL keeps it. Because the cascade then differs by dialect, deleting an area removes its widgets and the area row explicitly in one batch on every dialect, as `MenuRepository.delete` does for menu items.

### Runtime API

```ts
interface WidgetAreaQueryOptions {
	/** Defaults to the request locale, then the configured defaultLocale. */
	locale?: string;
}

function getWidgetArea(name: string, options?: WidgetAreaQueryOptions): Promise<WidgetArea | null>;
function getWidgetAreaWithCacheHint(
	name: string,
	options?: WidgetAreaQueryOptions,
): Promise<{
	data: WidgetArea | null;
	cacheHint: CacheHint;
}>;
function getWidgetAreas(options?: WidgetAreaQueryOptions): Promise<WidgetArea[]>;
```

`WidgetArea` gains `locale: string` and `translationGroup: string | null`. Both are additive.

`getWidgetArea()` resolves `resolveLocaleChain(options.locale)` and picks the first area row with that name whose locale is in the chain, ordered by chain rank and then by `id`, as `loadMenuRows()` does. The area and its widgets still load in one query. When i18n is off the chain has at most one entry, every existing row carries that locale, and the result is the same row as today.

`getWidgetAreas()` without a locale keeps its current meaning, "every area row", which now includes every locale. With a locale it returns one area per name, resolved through the chain. On a translated site, a template that calls `getWidgetAreas()` and then `.find((a) => a.name === name)` can get any locale's row; the widgets guide tells such templates to pass `locale` or call `getWidgetArea(name)`.

The prefetch shortcut inside `getWidgetArea()`, which reads the request-cached `widget-areas` list and picks an area by name, applies the same chain resolution in memory instead of taking the first row with that name.

`<WidgetArea>` passes `Astro.currentLocale` to `getWidgetAreaWithCacheHint()`. Anonymous requests take the middleware fast path without a request-context locale, so `resolveLocale()` alone would render the default locale for visitors. #4604 fixed the same problem for the component widgets. `WidgetRenderer` passes `Astro.currentLocale` to `getMenu()` and lets the menu's own fallback chain decide. A French page shows the French menu, and a German page rendering the English fallback area still shows a German menu when one exists.

### Caching and the logged-out path

The request-cache key `widget-area:${name}` becomes `widget-area:${name}:${locale ?? "*"}` and the object-cache key `area:${name}` becomes `area:${name}:${locale ?? "*"}`, where `locale` is the resolved head of the chain. The cache tag from `widgetAreaTag(name)` stays name-based, so editing any locale's widgets purges every page that renders that area name. That over-purges across locales, the same trade-off `menuTag(name)` makes.

`prefetchLayoutData()` already loads every area in one query through `getWidgetAreas()` and primes per-name request-cache entries. After this change the same single query returns every locale's rows. The prefetch resolves the request locale's chain in memory and primes `widget-area:${name}:${locale}` for each name. It adds no query.

`prefetchLayoutData()` gains a `locale` parameter, and the middleware's anonymous fast path passes its `context.currentLocale`, which is the value `Astro.currentLocale` returns while the same request renders. The fast path's request context still carries no locale, so `resolveLocale()` behaves as before for every other helper. `prefetchMenus()` receives the same locale and calls `getMenu(name, { locale })`, so the menu entries it primes match the keys `WidgetRenderer` reads. Without that, a menu widget on a translated page would miss the primed default-locale entry and add a query. If the two ever differ, `<WidgetArea>` misses the primed entry and runs its own query, so the result stays correct and only the prefetch benefit is lost. A render test pins that the keys match on a localized route.

The `query-counts` snapshots must stay unchanged for every route. They render a single-locale site, so a render test on a localized route also asserts the query count for an area with a menu widget.

### REST API

Every route under `/_emdash/api/widget-areas` accepts an optional `?locale=` query parameter, parsed with the existing `localeFilterQuery`. The admin needs exact rows, so the REST API doesn't apply the fallback chain:

- `GET /_emdash/api/widget-areas?locale=` returns one entry per area name. An entry is that locale's row when it exists. Otherwise it is the fallback row, marked with `fallback: true` and its own `locale`. Without `locale` it returns every row, as today.
- `GET /_emdash/api/widget-areas/:name?locale=` returns that locale's row or `NOT_FOUND`.
- Writes (create widget, update, delete, reorder) target the exact `(name, locale)` row and return `NOT_FOUND` when that locale has no area, so an editor never changes the fallback locale's widgets by accident.
- Without `locale`, every single-area read and write works as today while the name has one row. When it has rows in more than one locale, it returns `AMBIGUOUS_LOCALE`, the error code the menu routes use for the same case.

`POST /_emdash/api/widget-areas` accepts an optional `locale` in the body. A duplicate `(name, locale)` returns `CONFLICT`.

Two endpoints mirror the menu translation routes:

- `GET /_emdash/api/widget-areas/:name/translations?locale=` lists every row in the area's translation group with its locale. Permission `widgets:read`.
- `POST /_emdash/api/widget-areas/:name/translations?locale=<source>` with `{ locale, label? }` creates the target locale's area in the source's translation group and copies the source's widgets in order with new IDs, in one transaction. Permission `widgets:manage`. A missing source returns `NOT_FOUND`, an existing target returns `CONFLICT`, and a locale outside the configured locales returns `VALIDATION_ERROR`.

`DELETE /_emdash/api/widget-areas/:name?locale=` deletes that locale's row and its widgets. Without `locale` it follows the `AMBIGUOUS_LOCALE` rule above, so it never deletes every translation at once.

No permission strings are added. Every write invalidates `widgetAreaTag(name)` and the widgets object-cache namespace, as today.

### Admin

The Widgets page gets the locale switcher that `MenuEditor` uses when more than one locale is configured. The selected locale goes into the route's `locale` search parameter, into every widget request in `lib/api/widgets.ts`, and into the TanStack Query keys, so switching locale never shows another locale's cached list. Drag-and-drop IDs, which use `area:${name}` today, stay unique because the page lists one entry per name for the selected locale. When the selected locale has no row for an area, the page shows a notice that the area falls back to another locale's widgets, with a **Translate** action that calls the translations endpoint and switches to the new copy. The fallback widgets aren't editable from that view.

All new strings go through Lingui, the layout uses logical Tailwind classes, and the switcher is tested in Arabic.

### Seeds, export, transfer and snapshots

- `SeedWidgetArea` gains optional `id`, `locale` and `translationOf`, following `SeedMenu`. A seed without them creates default-locale areas, so existing seeds keep working. `SeedFile.defaultLocale` applies as it does for menus.
- Seed apply looks areas up by `(name, locale)` after `resolveConfiguredLocale()` and uses `(name, locale)` as its `ON CONFLICT` target. Today it uses `name`, which no longer matches a unique constraint after the migration. Seed validation rejects duplicate `(name, locale)` pairs instead of duplicate names, and checks `translationOf` the way it does for menus.
- `emdash export-seed` writes one entry per locale row, links translations through `translationOf`, and includes widget area locales when it collects the site's locales.
- Site transfer adds `locale` and `translationGroup` to the widget area record. Both are optional in `widgetAreaRecordSchema`, so packages from older versions still validate. The scaffold item and the `widget_area_name` unique key gain the locale and become `widget_area_name_locale`, like `menu_name_locale`. Packages without `locale` import as the target site's default locale. `SITE_PACKAGE_FORMAT_VERSION` stays at `"1"`, because the change only adds optional fields. A package with translated widget areas fails to import on an older EmDash, which rejects unknown fields on that strict record. That is the expected result when importing newer data into an older version.
- Snapshots already copy both tables in full and pick up the new columns.

## Compatibility and migration

The change is additive for every public interface. `getWidgetArea(name)`, `getWidgetAreas()`, `<WidgetArea name>` and the REST routes keep working without a locale. `WidgetArea` gains two fields. Seeds and transfer packages from older versions import as default-locale rows.

One migration, numbered after the latest at implementation time, changes `_emdash_widget_areas`:

- **SQLite and D1** can't alter a unique constraint, so the migration rebuilds the table with a staged `_emdash_widget_areas_new`, as 036 does for `_emdash_menus`. D1 enforces foreign keys but ignores `PRAGMA foreign_keys = OFF`, so dropping the old table would cascade into `_emdash_widgets` and delete every widget. The migration rebuilds `_emdash_widgets` first, without the foreign key, and recreates `idx_widgets_area`. Then it rebuilds the areas table. The widgets rebuild runs only while `PRAGMA foreign_key_list(_emdash_widgets)` still lists the key, and the areas rebuild only while the table has no `locale` column. `resumeStagedRebuild()` renames a staged copy back before either check, because `PRAGMA foreign_key_list` returns no rows for a missing table and would otherwise skip the rename (the gap migration 071 had to repair for 040). A run that stopped after any statement restarts cleanly.
- **PostgreSQL** adds the columns with `ADD COLUMN IF NOT EXISTS`, backfills `translation_group`, and swaps the unique constraint, as `pgWiden()` does in 036.

Existing rows get the default locale and `translation_group = id`. Nothing is copied or renamed, so every existing area and widget stays reachable at the same name.

Rolling deploys: old code reads and writes areas by name only. Until an editor creates a second locale row, there is exactly one row per name and old code behaves as before, with two exceptions:

- Old seed apply uses `ON CONFLICT (name)`, which fails once the unique key is `(name, locale)`. Seeds run during setup and template installs, not on live traffic, so the risk is an install started on an old instance while a migrated database is already in place.
- After a translation exists, old public reads may return either locale's row, and old admin writes may land on the translated row.

Translating an area is an editor action after the deploy, so this window is the rest of the rollout.

Rollback: `down` is a no-op once translations exist, because removing the locale would leave two rows with the same name. A host that rolls back the application keeps working with the expanded schema under the rolling-deploy caveat above.

## Security and privacy

The new routes reuse `widgets:read` and `widgets:manage`, the CSRF header requirement and `parseBody` / `parseQuery` validation. The `locale` parameter is checked with the existing `localeCode` pattern and normalized with `resolveConfiguredLocale()`, as the menu routes do. It is always a bound value, never interpolated. Widget content is rendered the same way as before. No new security or privacy surface.

## Performance

- Logged-out renders: `<WidgetArea>` still runs at most one query per area name, and none when the prefetch primed it. The prefetch query is unchanged apart from returning more rows on translated sites. `query-counts` must not change.
- Cold start: no new startup query. The migration runs with the other migrations.
- Storage: one area row and one copy of its widgets per translated locale. Widget areas are small chrome tables.
- Object cache: one entry per area name and resolved locale instead of one per name.

## Failure handling

The translate endpoint writes the new area row and its widget copies as one atomic batch on D1 and inside a transaction elsewhere, using the same pattern as `executeMenuWrite()` in the menu repository. A half-copied area can't exist. A retry after a lost response returns `CONFLICT` for the existing target, and the admin treats that as "already translated" and switches to it.

A locale row whose widgets fail to parse keeps today's behavior: invalid JSON content or props is skipped for that widget only.

If the prefetch fails, `<WidgetArea>` runs its own query, as today.

## Verification

- Migration tests on SQLite, PostgreSQL and real D1 (`tests/workerd/`): existing areas and widgets survive with the default locale and `translation_group = id`; widgets aren't cascaded away; a run stopped after each statement resumes; a non-`en` default locale is backfilled correctly.
- Runtime tests with `describeEachDialect`: locale resolution, fallback chain, i18n off, explicit `locale` option, `getWidgetAreas()` with and without locale.
- Render tests (`tests/repro/`): an anonymous `/fr/` request renders the French titles and rich text; a locale without a translation renders the fallback; a menu widget in a French area resolves the French menu; the prefetch key matches the key `<WidgetArea>` reads.
- API tests: writes on a missing locale return `NOT_FOUND`, duplicate translation returns `CONFLICT`, unqualified reads, writes and deletes with several locales return `AMBIGUOUS_LOCALE`, the list marks fallback rows, permissions are enforced, and deleting an area removes its widgets on every dialect.
- Seed apply with two locales of the same area name, re-applying a seed, and seed validation of duplicate `(name, locale)` pairs.
- Export-seed and transfer round trips with two locales, plus import of a package from before the change.
- `query-counts` snapshots unchanged.
- Admin: Playwright test for switching locale and translating an area, checked in Arabic.

## Rollout and implementation

1. **Storage and runtime.** Migration, locale-aware `getWidgetArea()` / `getWidgetAreas()`, `<WidgetArea>` and `WidgetRenderer` passing the locale, prefetch keys, and the REST `locale` parameter. Usable through the API and seeds on its own.
2. **Translations endpoint and admin.** The translations routes, the locale switcher and the Translate action on the Widgets page.
3. **Seeds, export-seed and site transfer.** Locale rows in every format, plus the widgets guide.

Each step ships with its changeset. No feature flag: a site without a second locale row behaves exactly as today.

## Alternatives

- **Per-field translations on a shared widget list** (a `_emdash_widget_translations` table keyed by widget and locale, or a JSON map in `title`). Editors add or remove a widget once for every locale, which is convenient when the structure is identical. It doesn't fit how EmDash localizes anything else: content, menus, taxonomies and bylines are all row-per-locale with a translation group. It also forces every locale to share widget order and component props, while sites often show different widgets per market (a local events list in one language only). Every read would need a join or a second lookup, and every writer (admin, seeds, transfer) a second shape.
- **Locale on `_emdash_widgets` instead of on the area.** Keeps one area row and filters widgets by locale. Area label and description stay unlocalized, the unique key stays on the area, and an area with no widgets in a locale can't be told apart from an area that isn't translated, so fallback can't work.
- **Leave it to templates.** The widgets guide could recommend one area per locale (`sidebar-fr`) chosen in the template. That works today, but the admin shows unrelated areas, nothing links the translations, and seeds and themes can't ship a localized sidebar.

## Drawbacks

- A structural change to a translated area (add a widget everywhere) means editing each locale. That matches menus today.
- The migration rebuilds two tables on SQLite and D1. They're small, but the rebuild must be resumable and must not cascade, which is the riskiest part to get right.
- Cache tags stay name-based, so an edit in one locale purges pages in every locale that render the area.

## Open questions

- Should the admin offer **Translate** for all missing locales at once, or one locale at a time like menus?
- Should `getWidgetAreas()` without a locale keep returning every locale's rows, or resolve to the request locale by default? Returning every row is the compatible choice; resolving would be more useful for templates that list all areas.
