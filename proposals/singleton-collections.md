---
title: Collections that hold a single entry
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: Daniel Mueller (@danielmlr)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/2631
  - https://github.com/emdash-cms/emdash/discussions/1631
created: 2026-11-17
---

# Collections that hold a single entry

## Summary

A collection can be marked as a singleton by adding `"singleton"` to its `supports` list. A singleton collection holds at most one active entry per locale, and all of its active entries belong to one translation group. On a site with one locale, that means one entry. On a multilingual site, it means one entry per locale, linked as translations.

Core enforces the rule on every write path. A per-collection partial unique index on the locale stops a second active entry in any locale, whichever path the write takes: the admin, the REST API, MCP, a plugin, a seed, a site import, or a restore from the trash. A check in the runtime refuses a second create with a clear 409 error before plugin hooks run, and the duplicate and restore handlers do the same for their writes. The index catches what the checks can't see, such as two creates at the same moment, and its refusals map to the same codes.

In the admin, the sidebar link for a singleton collection opens its entry directly, in the current content locale. The list view, "New" and "Duplicate" give way to a single editor. Templates read the entry with `getEmDashSingleton()`. A singleton collection can also use a URL pattern without `{slug}`, so a home page can live at `/`.

The one entry can be moved to the trash and unpublished like any other. An empty singleton is a valid state: the admin then offers to create the entry, and the read returns `null`.

## Problem and user case

Some content exists exactly once: a home page, an "About" page, a site-wide banner, or a record of company details such as the phone number and address that every page shows. EmDash has no way to say so. Every collection is a list.

Today a site models these as a normal collection and keeps to one entry by convention. That breaks in three ways, all reported in [Discussion #2631](https://github.com/emdash-cms/emdash/discussions/2631) and [Discussion #1631](https://github.com/emdash-cms/emdash/discussions/1631):

- **A second entry gets in silently.** On @marks-zyz's engineering-firm site, a `configuracoes` collection holds the values that repeat across every page, and the site reads the first row. When an editor creates a second entry, nothing refuses it, and the site keeps rendering the first one. The editor's change seems to do nothing, and a non-technical client can't work out why.
- **The admin is built for lists.** The sidebar opens a list that always holds one row, so editing takes two clicks. "New", "Duplicate" and delete are offered for something that should exist once.
- **Multilingual sites need one entry per locale.** @stephanedemotte's bilingual site has eight page-like collections (home, about, contact, shops and more), each with one entry per locale, linked as translations. A rule of "exactly one entry" would make the English home page impossible. The rule has to be "one per locale", with a second French home page refused and the English translation of it allowed.

Two people have built their own versions, and both hit limits that only core can lift:

- **[origin-emdash-uniq](https://github.com/stephanedemotte/origin-emdash-uniq)**, a native plugin by @stephanedemotte, refuses a new entry when one exists, refuses duplicates, and refuses a restore into an occupied locale. When it was built, `content:beforeSave` didn't receive the locale or `translationOf` (#3566 added both a day later), so it guards the content API from a site middleware instead. It hides "Add New" and "Duplicate" with CSS rules and `aria-label` matches in the admin.
- **[dennisklappe/emdash-klappe](https://github.com/dennisklappe/emdash-klappe)**, a fork by @dennisklappe, adds `supports: ["singleton"]` with the sidebar linking straight to the entry. It allows exactly one entry per collection, so it refuses translations.

Neither covers seed and import writes, which skip the content API and its handlers, or two editors creating at the same moment. The `content:beforeSave` recipe for "one entry per locale" that `reference/hooks.mdx` documents since #3566 misses more, because duplicate, restore and seeds never run that hook.

Other answers cover parts of this. Since #3440, the dashboard's "+ New" button can be switched off per collection (`admin.quickCreate`), which removes the most visible trap. `hidden` removes the collection from the sidebar, which is the opposite of what a settings record needs. Site settings (`getSiteSettings()`) have a fixed set of keys, so bespoke fields such as hero copy or business hours don't fit there.

## Example

A non-routable singleton for site-wide details, defined in a seed:

```json title="seed.json"
{
	"slug": "site_info",
	"label": "Site info",
	"labelSingular": "Site info",
	"supports": ["drafts", "revisions", "singleton"],
	"routable": false,
	"fields": [
		{ "slug": "phone", "label": "Phone", "type": "string" },
		{ "slug": "address", "label": "Address", "type": "text" }
	]
}
```

A layout reads it:

```astro title="src/layouts/Base.astro"
---
import { getEmDashSingleton } from "emdash";

const { entry: info, cacheHint } = await getEmDashSingleton("site_info", {
	locale: Astro.currentLocale,
});
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---

<footer>{info && <p>{info.data.phone}</p>}</footer>
```

A page-like singleton can use a URL pattern without `{slug}`, so the home page is listed at `/` in the sitemap and in preview links:

```json title="seed.json"
{
	"slug": "home",
	"label": "Home",
	"labelSingular": "Home",
	"supports": ["drafts", "revisions", "singleton"],
	"routable": true,
	"urlPattern": "/",
	"fields": [{ "slug": "hero", "label": "Hero", "type": "portableText" }]
}
```

On a site with English and French, the editor sees one "Home" item in the sidebar. Clicking it opens the English home page when English is the content locale. Switching the content locale to French opens the French one, or offers "Translate from English" if it doesn't exist yet. A request that tries to create a second English home page through the API gets this response:

```json
{
	"success": false,
	"error": {
		"code": "SINGLETON_EXISTS",
		"message": "Home already has an entry. Translate it to add another locale.",
		"details": { "existingId": "01JD…", "locales": ["en"] }
	}
}
```

## Goals

- A collection can be marked as a singleton, and unmarked, from a seed, the content type editor, the REST API and MCP.
- In a singleton collection, at most one active entry exists per locale, on every write path, including concurrent writes, on SQLite, PostgreSQL and D1.
- All active entries of a singleton collection belong to one translation group on every path a request goes through (create, duplicate, restore, seed apply, site import analysis), except when two first creates in different locales race (see Failure handling).
- A refused create, duplicate or restore, or a refused attempt to turn the flag on, returns a 409 with a stable error code, never a 500. A create the checks refuse never reaches plugin `content:beforeSave` hooks; only a create that loses a race to another is refused after them, by the index.
- In the admin, a singleton collection opens as one editor in the current content locale, without "New" or "Duplicate".
- Templates read the entry with one query per render, with locale fallback.
- A singleton collection can use a URL pattern without `{slug}`, such as `/`.
- Nothing changes for collections that don't opt in.

## Non-goals

- A setting that designates any entry as the site's home page ([Discussion #4744](https://github.com/emdash-cms/emdash/discussions/4744)). A singleton with the pattern `/` covers sites that model their home page as a singleton; a pointer to an entry in another collection is a separate design.
- Extensible site settings: letting sites or plugins add keys to `getSiteSettings()`. A non-routable singleton collection covers the editorial need (custom fields, drafts, revisions, locales, Editor permission) without changing settings.
- A general limit such as `maxEntries: 3`. A unique index can express only "one", and a count check races on D1. The value in `supports` can be widened later if there is demand.
- A separate "globals" kind beside collections. A singleton is an ordinary collection, so every collection feature works for it.
- Creating the entry automatically when the collection is created.
- New plugin hooks for duplicate and restore.
- Purging the route cache when plugin settings change, raised in #2631. That's a plugin settings question.

## Detailed design

### The flag

`CollectionSupport` gains `"singleton"`. It is accepted wherever `supports` is today: the seed type, the registry's `VALID_COLLECTION_SUPPORTS`, the REST schema enum, the MCP schema tools, and the content type editor. This follows `no-scheduling` (#4729), which added an opt-out to `supports` that the server enforces, without a migration.

`supports` is stored as a JSON array in `_emdash_collections.supports`, so the flag needs no migration and no change to the site transfer format. The manifest already publishes `supports`, so the admin and the runtime read the flag from data they already load.

### The index

Each singleton collection gets one extra index on its content table:

```sql
CREATE UNIQUE INDEX uidx_sgl_ec_<slug> ON ec_<slug> (lower(locale)) WHERE deleted_at IS NULL;
```

It mirrors the existing translation index (`(translation_group, lower(locale)) WHERE deleted_at IS NULL AND translation_group IS NOT NULL`), which every content table already has with the same SQL on SQLite, D1 and PostgreSQL. The new index puts its discriminator first, and names longer than 63 bytes are shortened with a hash suffix, as plugin storage index names are since #4715. A shortened name never shares its first 63 bytes with the translation index or another collection's index.

The registry owns the index. On `createCollection`, `updateCollection` and `importCollection`, when the request names `supports`, the registry compares the requested singleton state with the stored value and with whether the index exists (one catalog read), and runs DDL only when they differ:

- **Turning it on:** check the existing data, create the index, then write `supports`. The check refuses when any locale has more than one active entry, or when active entries span more than one translation group. It returns `SINGLETON_REQUIRES_MIGRATION` (409) and lists the entries, following the precedent of `FIELD_UPDATE_REQUIRES_MIGRATION`. Trashed entries don't count. If a concurrent insert makes the index creation fail after the check passed, the same code is returned.
- **Turning it off:** drop the index, then write `supports`. Nothing is lost.

The content type editor sends `supports` with every save, so the comparison keeps ordinary saves free of DDL. It also repairs a half-done change. D1 has no transactions, so the DDL and the `supports` write can be separated by a failure. If the index exists without the flag, or the flag without the index, the next save that names `supports` brings the two back in line.

### The rule on each write path

| Path | Rule | Where |
| --- | --- | --- |
| Create without `translationOf` | Refused when the collection has any active entry, in any locale. 409 `SINGLETON_EXISTS`, with the existing entry's id and its locales, so the client can translate it instead. | In `EmDashRuntime.handleContentCreate`, after the collection is loaded and before `content:beforeSave` hooks run. A caller that skips the runtime is stopped by the index, with the same code. |
| Create with `translationOf` | The existing translation flow. A trashed source is already refused with 404, so a create can't join an old group. An occupied locale is refused by the existing checks or, failing those, by either index. | Unchanged, plus the error mapping below. |
| Duplicate | Refused. 409 `SINGLETON_DUPLICATE_REFUSED`. | Content duplicate handler. |
| Restore from the trash | Refused when the entry's locale already has an active entry, or when active entries exist in another translation group. 409 `SINGLETON_EXISTS`. | Content restore handler, plus the index. |
| Trash, permanent delete, unpublish | Allowed, as for any collection. | Unchanged. |
| Update | Unchanged. An update can't change the locale or translation group. | Unchanged. |
| Plugin `ctx.content`, MCP | The same runtime check, handlers and index apply. | See below. |
| Seed apply | Seed validation, the create rule checked against the database, and the index. Seeds don't go through the content API. | See below. |
| Site import | The package analyzer and the index. An import goes only into an empty site. | See below. |

The rule allows any number of entries in the trash. Only active entries count.

**Why refuse in every locale.** On a multilingual site, a create without `translationOf` in a new locale would start a second translation group: an English home page in one group and a French one in another, shown in the admin as unrelated entries. Refusing every plain create once an entry exists keeps one group with one rule to explain, and it's the rule origin-emdash-uniq uses. The error names the existing entry, so a client can switch to translating it. Because the check counts active entries in any locale, locale aliases (`en` and `en-US`) need no special handling here. Translation creates keep the existing alias-aware check.

**Error mapping.** Each content handler's catch block learns to recognize the singleton index by its stored name before its generic unique-violation branch. The match is a substring match without regard to case, so the D1 binding's `D1_ERROR:` prefix doesn't matter. When one row violates both indexes, SQLite and D1 name one of them and PostgreSQL the other, so for a singleton collection either name maps to the same code. Restore today maps only the translation index and duplicate maps no unique violation, so both gain the mapping. On a collection that has the index but not the flag, the 409 says the collection still carries a singleton index and that saving its settings removes it.

**Seeds.** Seed validation (`validateSeed`, which `applySeed` runs before it writes anything and `emdash seed --validate` runs alone) refuses a seed with two entries in one locale for a singleton collection, and a seed whose second and later entries lack `translationOf`. Validation can't see the database, so `applySeed` also applies the create rule: for each singleton collection in the seed, it reads the active entries once and counts the entries it creates. When the collection already has an active entry, a seed entry that would start a new translation group is refused. That's an entry without `translationOf`, or one whose `translationOf` source the seed can't resolve because it's missing or was skipped while in the trash. Today `applySeed` creates such an entry without a link; for a singleton collection it stops there instead. `applySeed` creates the collection, and with it the index, before its entries, so the index still refuses an entry in a locale that already has one. Either refusal stops `applySeed` at that entry with a message that names the collection and locale.

**Site import.** `importCollection` creates the index right after the content table and before any entry, so the index refuses a violating entry. The analyzer learns the same rules as seed validation, so a violating package is refused during analysis, before any write, naming the entry.

**Plugins and MCP.** Plugin `ctx.content.create` and the MCP content tools call the runtime handlers, so the same rules and codes apply. A plugin write from inside a save hook skips save hooks only, not the rule.

### Reading the entry

Templates read the entry with a new query function:

```ts
getEmDashSingleton<T>(
	collection: string,
	options?: { locale?: string },
): Promise<{ entry: ContentEntry<T> | null; cacheHint: CacheHint; error?: Error }>;
```

It returns the entry for the requested locale, falling back through the configured locale chain, with the same visibility rules as `getEmDashEntry`: published entries for visitors, drafts with a preview token. One query serves it, using the singleton index. The read is wrapped in `requestCached`, keyed by collection, resolved locale and preview mode, so a layout and a component that both read it cost one query per render. `getEmDashEntry` has no request cache today ([#4838](https://github.com/emdash-cms/emdash/issues/4838)); the new accessor doesn't depend on that being fixed. An empty singleton returns `entry: null`, and the template decides what to show.

`resolveEmDashPath(path)` gains one branch. Today it skips a pattern match that has no `slug` parameter. When the match belongs to a singleton collection, it returns the singleton's entry for that locale instead. The flag comes from the collection list it already reads to build its pattern cache.

### URL patterns

A singleton collection may use a URL pattern without `{slug}`, such as `/` or `/about`. The server already accepts such patterns; only the content type editor requires `{slug}`. The editor drops that requirement for singleton collections and keeps it for every other collection, where all entries would share one URL. With a literal pattern, the sitemap and the preview URL list the entry at that path, with the configured locale prefix for other locales. A slug change creates no redirect, because the URL doesn't change.

### Admin

- **Content type editor.** "Single entry" joins the Features checkboxes, with the description "Holds one entry, or one per language. The sidebar opens it directly." When turning it on is refused, the error lists the conflicting entries with links.
- **Sidebar and command palette.** The item uses `labelSingular`, and its link stays `/content/<collection>`. Since #4628, a navigation item's ID is its link path and each user's sidebar arrangement stores those IDs, so keeping the path keeps every saved arrangement working. Settings → Sidebars uses the same list, so it shows the same label.
- **Opening the collection.** For a singleton collection, `/content/<collection>` goes straight to the editor of the entry in the active content locale, replacing the history entry. When that locale has no entry but another does, the screen offers "Translate from <locale>", which opens the existing translation flow. When there is no entry at all, it offers "Create <labelSingular>". The sidebar, the command palette and the dashboard all lead through this one route.
- **The list.** An "All languages and trash" link in the editor opens the list view with a search parameter that skips the redirect, so translations and trashed entries stay reachable. "New" and "Duplicate" are hidden there.
- **Direct links.** `/content/<collection>/new` without `translationOf` redirects to the existing entry when there is one.
- **Dashboard.** The quick action is off by default for singleton collections. An explicit `admin.quickCreate: true` still turns it on. The content type editor's switch shows that default and saves `true` when turned on, where today it stores only `false`.
- **Trash and unpublish.** Both stay available. When the entry is the last active one, the confirmation names the effect: "The site will show no Site info in English until you create or restore it."

All strings go through Lingui, and the layout uses logical properties for RTL.

### REST, MCP and documentation

- The REST collection schemas accept `"singleton"` in `supports`. OpenAPI is regenerated. The new error codes are documented in the REST reference.
- The MCP `schema_create_collection` and `schema_update_collection` descriptions explain the value. The content tool descriptions mention the rule and its codes.
- Docs: collections (the new feature), hooks (the recipe points to the flag), site settings (bespoke site-wide fields as a singleton), internationalization (the per-locale rule), seed files, and the REST and MCP references.

## Compatibility and migration

- **Additive.** Collections that don't list `"singleton"` behave exactly as before. No existing request changes meaning. Minor releases of `emdash` and `@emdash-cms/admin`.
- **No migration.** The flag lives in the existing `supports` column. The index is created per collection by the registry, only for collections that opt in.
- **Site transfer.** The format is unchanged. `supports` already travels as a JSON array, so packages from sites without singletons are byte-for-byte the same.
- **Rolling deploy and older runtimes.** A runtime older than this feature drops unknown `supports` values when it reads a collection. During a rolling deploy, an older isolate doesn't apply the new checks, but the index still refuses a second entry in a locale, with a generic `CONFLICT` or `CONTENT_*_ERROR`. If someone saves the collection's settings on an older isolate, the flag is written without `"singleton"` while the index stays. That state fails closed: a second entry is still refused, with a message saying the collection still carries a singleton index, and the next settings save on the new version removes the index or restores the flag.
- **Downgrade.** Turn the flag off before downgrading, so no index enforces the rule with the older version's generic errors. An older version can import a package with a singleton collection, but it doesn't know the value and creates no index, so the rule isn't enforced there. The changeset says both.
- **Rollback of a site's choice.** Turning the flag off drops the index and loses nothing.

## Security and privacy

- **Authorization.** No new permission. Marking a collection as a singleton is a schema change and needs `schema:manage`, as any other collection setting does. The write rules apply to every role equally. They refuse writes and never allow one that permissions refuse.
- **Information in errors.** `SINGLETON_EXISTS` returns the existing entry's id and locales. Creating content needs `content:create` and reading drafts needs `content:read_drafts`, and both start at Contributor, so anyone who can trigger the error can already list the collection's entries. If collection-scoped permissions from the custom roles RFC ([#4156](https://github.com/emdash-cms/emdash/pull/4156)) land, the details should only be included when the caller can read the collection.
- **Untrusted input.** The index name comes from the collection slug, which is already validated against `/^[a-z][a-z0-9_]*$/`. The DDL uses `sql.ref()` for identifiers. No new input reaches SQL.
- **Privacy.** No personal data is added or exposed.

## Performance

- **Logged-out reads.** No existing route gains a query. `getEmDashSingleton` costs one query per distinct call in a render, thanks to the request cache, and the target is the same count as `getEmDashEntry(collection, slug)`. `resolveEmDashPath` makes one entry query for a matched literal pattern, as it does for a `{slug}` match today. Both are measured with fixtures in the query-count snapshots before the slice that adds them lands.
- **Writes.** Creating an entry in a singleton collection costs one extra read, in the runtime check (the active entries' ids and locales, at most one per locale). The flag rides on the collection read the runtime already does. Restore reads the collection's settings (one request-cached read on every restore, since the restore handler reads none today) and, for a singleton collection, its active entries. Duplicate is refused with no extra query, because the duplicate handler already reads the collection. Applying a seed reads the active entries once for each singleton collection it contains, on the CLI and setup paths only. Creates, updates and trashes in collections without the flag pay nothing.
- **Schema saves.** Saving a collection's settings costs one catalog read to compare the index with the flag. These are admin-only writes.
- **Storage.** One small index per singleton collection, over a handful of rows.

A local prototype measured the enforcement, not query counts. It built the index, the checks and the error mapping against EmDash at `246ca792`, with two differences from this design: a column for the flag rather than `supports`, and the create check in the content handler, after plugin hooks, rather than in the runtime before them. Its tests ran 24 cases on SQLite and PostgreSQL 17.11 (48 of 48 passed) and 8 on D1 through a miniflare binding (8 of 8). No exercised path left two active entries in one locale. Every handler refusal became a 409 once restore mapped both indexes. In every concurrent-create run (SQLite and PostgreSQL with two parallel requests, D1 with three parallel requests over five rounds), each losing request had already passed the handler check and was stopped by the index. That's the reason for the index: a check alone, outside a transaction, would have let two or three entries in on every dialect.

## Failure handling

| Situation | Result |
| --- | --- |
| Create without `translationOf` while an entry exists | 409 `SINGLETON_EXISTS` with the existing id and locales. No `beforeSave` hook runs. The admin offers to open or translate the entry. A WordPress import reports the item as failed in its per-item results. |
| Translation into an occupied locale | 409 `CONFLICT` (the existing message), whichever index the database names. |
| Duplicate | 409 `SINGLETON_DUPLICATE_REFUSED`. |
| Restore into an occupied locale, or while another group has active entries | 409 `SINGLETON_EXISTS`, naming the locale. |
| Two concurrent creates in the same locale | One entry. The others get 409 `SINGLETON_EXISTS` through the index, after their `beforeSave` hooks ran. |
| Two concurrent first creates in different locales | Both succeed and start two translation groups. This race needs two people creating the first entry of a collection in different locales at the same moment. Each locale still has one entry, and trashing one of them repairs it. |
| Last active entry trashed, or last published entry unpublished | Allowed. The read returns `null` for visitors. After a trash, the admin offers to create or restore the entry. |
| Turning the flag on over violating data | 409 `SINGLETON_REQUIRES_MIGRATION`, listing the entries. No index, flag unchanged. |
| Index without flag, or flag without index | Writes keep failing closed, or only the runtime and handler checks apply. The next settings save that names `supports` brings the two in line. |
| Seed with two entries in one locale, or a second entry without `translationOf` | Seed validation refuses it before writing, in `applySeed` and in `emdash seed --validate`. |
| Seed entry in a locale that already has an entry in the database, or one that would start a second translation group (no `translationOf`, or a source the seed can't resolve) | `applySeed` stops at that entry with a message naming the collection and locale. No entry starts a second group. |
| Site package that violates the rule | Refused at analysis, naming the entry. |
| Older isolate during a deploy | The index still refuses, with a generic `CONFLICT` or `CONTENT_*_ERROR`. |
| Long collection slug | The index name is shortened with a hash suffix, and the error mapping matches the stored name. |

Operators see refusals as 409 responses with stable codes in the REST API, as the same codes in MCP, and as messages in the admin. No background job is involved.

## Verification

- **Each dialect** (`describeEachDialect`: SQLite, and PostgreSQL with `EMDASH_TEST_PG`): create twice; translation create; plain create in a second locale; duplicate; trash, create and restore; repository-level insert (standing in for seed and import writes); concurrent creates with `Promise.all`; turning the flag on over violating data; turning it on and off; a long slug; trashing the last entry, then creating a new one and restoring the old one; real `applySeed` with violating seeds, and over existing entries with a plain entry in a free locale and with a translation whose source is in the trash.
- **D1:** the same rules through the raw D1 binding in the existing workerd harness, which exercises D1's non-transactional path.
- **Runtime level:** a `content:beforeSave` hook is not called for a refused create through REST, MCP and `ctx.content`; `translationOf` naming a trashed entry returns 404 and starts no group; a type editor save that doesn't change the flag runs no DDL; the half-done states repair on the next save.
- **Compatibility:** a collection stored with `"singleton"` and read by the current filter; a site export and import round trip, with and without a singleton; a package without singletons re-exports byte for byte; a violating package is refused at analysis.
- **Query counts:** the existing snapshot doesn't change; a fixture page that reads a singleton twice in one render costs the same as one slug read; a catch-all route resolving `/` to a literal-pattern singleton costs the same as a `{slug}` match.
- **Admin:** component tests for the sidebar label, the redirect, the empty and translate states, the hidden actions, the list link and the dashboard default; Playwright for sidebar to editor, translating from another locale, and the refusal in the type editor; desktop and phone screenshots, including Arabic.
- **Existing suites stay green**, including the translation-locale and save-hook-locale tests and the transfer suites.

## Rollout and implementation

| Slice | Content | Depends on |
| --- | --- | --- |
| 1. Core | The `"singleton"` value, the registry index with its comparison and data check, the runtime create check, the duplicate and restore rules, the error mapping, seed validation and the seed create rule, the import analyzer rule, REST and MCP schema fields, docs and changeset, with per-dialect and runtime-level tests. | This RFC accepted |
| 2. Admin | The Features checkbox, the sidebar label, the opening route with its empty and translate states, the list link, hidden actions, the dashboard default, the trash and unpublish confirmations, and URL patterns without `{slug}` for singletons, with screenshots. | Slice 1 |
| 3. Reading | `getEmDashSingleton`, the `resolveEmDashPath` branch, docs and query-count fixtures. | Slice 1 |

Slices 2 and 3 can land in either order, but slice 2 should follow slice 1 in the same release, so the server guard never ships without its admin. No runtime feature flag is needed, because the behavior is opt-in per collection. A new module for the index helpers has no import-time side effects, as the runtime's handler imports require since #4596.

## Alternatives

- **A column, `_emdash_collections.singleton`.** Typed and explicit, and an older runtime would neither read nor rewrite it. It would need migration 098, a new classification in the site transfer format (exported only when true, so packages without singletons stay readable by older importers), and every site's export would fail on an older runtime during a rolling deploy until the deploy completes, as with every column added to a portable table. `supports` avoids all three, and since #4729 it already carries a restriction the server enforces. The cost is that an older runtime drops the value, which this design handles by failing closed.
- **A separate "globals" kind** beside collections, as in Payload and Statamic. Every collection feature would need re-implementing for it, and products that took this route report parity gaps that last for years. Craft is deprecating its global sets in favor of single-entry sections, and Keystone replaced its `singleton()` with an `isSingleton` flag on a list.
- **Admin-only enforcement**, hiding "New" and "Duplicate". The API, MCP and imports would still create a second entry. Directus, DatoCMS and Contentstack each had issues reported against exactly this gap.
- **A `content:beforeSave` hook**, in core or a plugin. Duplicate, restore and seeds never run it, and a count-then-insert check races on D1, which has no transactions.
- **Checks without an index.** They give good messages, which is why this design keeps them, but a write that skips them, such as a direct call to the content handler or a repository-level insert, meets no check, and the prototype showed every losing concurrent request passing them.
- **Upsert instead of refusing**: a create on a singleton updates the existing entry, as Strapi and Directus do. It would change what a create request means for one kind of collection, so a script that creates a "second home page" would overwrite the first instead of failing. It also conflicts with the translation flow, where `translationOf` already means "add a locale to this entry".
- **One entry regardless of locale**, as in the fork. It rules out the multilingual sites that asked for this.
- **One entry per locale without the shared group** (refusing only within the same locale). It allows an English home page and a French one that the admin shows as unrelated entries.
- **A second index on the group's root entries**, which would also put "one translation group" in the database and close the concurrent first-create race. The prototype showed it works on all three dialects, but it needs a rule for trashing the root entry while translations stay active, and more error mapping. It can follow if the race turns out to matter.
- **Refusing to trash the last entry.** Unpublishing already leaves the site without the entry, and the empty state exists anyway before the first entry is created. A refusal would add an error code and a read on every trash while protecting nothing that unpublishing doesn't already allow.
- **A plugin.** origin-emdash-uniq shows how far a plugin gets. It can't create an index, its hooks don't see duplicate, restore or seed writes (it needs a site middleware to refuse the first two), and it has to hide admin buttons through the DOM.

## Drawbacks

- **The first per-collection index created at runtime for content.** The registry gains index DDL tied to a collection setting, and error mapping that recognizes an index by name. Unique violations are already detected by matching message text in the content handlers, so this follows an existing, somewhat brittle pattern.
- **`supports` now mixes features and rules.** With `no-scheduling` and `singleton`, the list is no longer only "features the editor offers".
- **Older runtimes lose the flag silently.** A settings save on an older version, or an import into one, drops the rule. The index makes the first case fail closed; the second is documented.
- **One documented race.** Two people creating the first entry in different locales at the same moment end up with two translation groups.
- **The admin gains a special case.** The collection route redirects for singletons, and the list moves behind a link.

## Open questions

- **The accessor's name.** `getEmDashSingleton(collection, options)` is proposed. An overload, `getEmDashEntry(collection)` without an id, is the alternative.
- **Whether URL patterns without `{slug}` belong in this RFC.** They are included because a home page is the headline example in both Ideas threads. If they move to a follow-up, the first release leaves a singleton home page at `/home` behind a redirect, as today.
- **The error details under collection-scoped permissions**, if the custom roles RFC lands first.
