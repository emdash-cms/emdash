---
title: Record which source a translation follows and what wrote it
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4608
created: 2026-11-03
---

# Record which source a translation follows and what wrote it

## Summary

Each content translation records the sibling it was translated from, a fingerprint of that sibling's translatable content at the time, and an optional origin string such as `human` or `machine:deepl`. EmDash compares the recorded fingerprint with the source's current one and reports the translation as current or outdated in the translations API, `getTranslations()`, the MCP tools and the admin locale switcher.

The RFC covers four pieces:

- Five nullable columns on every content table, written by the server during writes that already happen.
- New write inputs that confirm a translation against its source, change its source, or set its origin.
- The derived state in existing read surfaces, and a translation state filter for content lists.
- An explicit action that starts tracking existing translations, because the migration cannot know whether they are up to date.

Logged-out page renders gain no query.

## Problem and user case

A translation entry records which translation group it belongs to and nothing about its state. On current `main`:

- `translation_group` links siblings. It says which entries translate each other, not whether they still agree.
- `getTranslations()` and `GET /_emdash/api/content/{collection}/{id}/translations` return each sibling's `id`, `locale`, `slug` and `status`. `status` is the publication state.
- `FieldDefinition.translatable` decides whether a field is synced across locales or edited per locale. It says nothing about whether a translated value is current.
- `author_id` records who saved an entry. An API or MCP write is attributed to the token's user like a manual edit, so it says nothing about what produced the text.
- Revisions have no link to the source locale. "The source changed after this translation was written" cannot be reconstructed from history.

So EmDash cannot answer two questions that every localization workflow asks:

1. Has the source changed since this translation was written?
2. Did a person, a machine translation service or an importer produce this text?

Editors on any multilingual site hit the first question whenever someone revises a default-locale entry: nothing in the admin shows which translations now lag behind. Automated translation through plugins, the REST API or MCP agents needs both answers. Without the second, a tool that re-translates changed sources either overwrites corrections made in the admin, or refuses to touch any translation that differs from its last output and reports the same entries on every run.

[#2558](https://github.com/emdash-cms/emdash/issues/2558) reports this from a production site with about 2,700 translatable entries. The site keeps an external file of content hashes to notice source changes, stores provenance in an ordinary content field, and refuses to write any translation that diverged. Gettext, XLIFF and translation management systems record the same two facts: a fingerprint of the source a translation was made from, and a state or origin flag.

[Discussion #964](https://github.com/emdash-cms/emdash/discussions/964) asks for translation linkage in plugins and themes. This RFC adds the state that linkage lacks and uses the same read surfaces.

## Example

An editor publishes an English post, then creates its German translation from the admin. The German entry records the English one as its source. The editor translates the text and saves with Mark as current, which confirms the translation against the source's live revision. Its content response includes:

```json
{
	"id": "01JD0DE",
	"locale": "de",
	"translationSource": { "id": "01JD0EN", "revisionId": "01JD0R4", "state": "current" },
	"translationOrigin": "human"
}
```

A week later the editor rewrites the English title and publishes. Nobody touches the German entry, but the fingerprint it recorded for its source no longer matches, so the translations endpoint reports it as outdated:

```json
{
	"translationGroup": "01JD0EN",
	"translations": [
		{
			"id": "01JD0EN",
			"locale": "en",
			"slug": "hello",
			"status": "published",
			"translationState": null,
			"translationOrigin": "human"
		},
		{
			"id": "01JD0DE",
			"locale": "de",
			"slug": "hallo",
			"status": "published",
			"translationState": "outdated",
			"translationOrigin": "human"
		}
	]
}
```

The locale switcher in the German editor marks the entry as outdated. A translation plugin asks for outdated German posts, translates the new title and saves it with its own origin, confirming the translation against the source in the same write:

```http
PUT /_emdash/api/content/posts/01JD0DE
X-EmDash-Request: 1
Content-Type: application/json

{
	"data": { "title": "Neuer Titel" },
	"translationOrigin": "machine:deepl",
	"markTranslationCurrent": true
}
```

The entry is current again, with origin `machine:deepl`. When an editor later corrects a word in the admin, the origin becomes `human`. On its next run the plugin finds an origin it did not write and leaves the entry for a person.

## Goals

- Each translation records its source sibling, the source revision it was confirmed against and a fingerprint of the source's translatable content. The server maintains all three.
- EmDash derives the state `current`, `outdated`, `source-missing` or `untracked` without bookkeeping outside EmDash.
- The writer of a translation can record what produced it, and an unlabelled edit that changes the text does not keep the old label.
- State and origin are readable through the REST API, `getTranslations()`, the MCP tools and the admin, and content lists can be filtered by state.
- Existing sites, entries and API clients keep working without changes.
- Logged-out page renders and the translations endpoint gain no query.

## Non-goals

- State per field. Saying which field is outdated needs stable Portable Text block identity, which [Discussion #2318](https://github.com/emdash-cms/emdash/discussions/2318) covers. The fingerprint carries a format version so a per-field form can follow.
- Translation workflow: assignments, review steps or approvals.
- Machine translation inside EmDash. Plugins and external tools translate; this RFC records what they need.
- Menus, taxonomies, bylines, site settings and interface strings. They have their own translation storage and can adopt the same model in a later proposal.
- Showing a notice on public pages. Templates can read the state from `getTranslations()`; EmDash renders nothing by default.

## Detailed design

### Terms

- **Source:** the sibling a translation follows. A translation created with `translationOf` follows the entry it was created from, so a Swiss German entry created from the German one follows the German one, not the default-locale entry. Any non-deleted entry in the same translation group can be set as the source.
- **Translatable content:** the stored values of an entry's fields with `translatable: true`. Non-translatable fields are excluded because EmDash already syncs them across siblings. Slug, status, dates, bylines, taxonomy terms, references and SEO metadata are excluded. SEO metadata lives in `_emdash_seo` and is written directly, outside the draft and publish cycle that the fingerprint follows.
- **Content fingerprint:** `v1:` followed by the lowercase hex SHA-256 of the entry's translatable content in canonical form. The canonical form sorts field slugs, serializes values as JSON with object keys sorted, omits `null` and absent values, and removes Portable Text `_key` properties. Without `_key`, the fingerprint stays the same when the editor regenerates block keys without changing text. Strings are compared byte for byte, with no Unicode normalization.

### Data model

One migration adds five nullable columns to every `ec_*` table:

| Column                       | Type    | Holds                                                                                |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `content_fingerprint`        | text    | Fingerprint of this entry's own stored translatable content                          |
| `translation_source_id`      | text    | Id of the source sibling                                                             |
| `translation_source_hash`    | text    | The source's `content_fingerprint` when this translation was last confirmed           |
| `translation_source_revision_id` | text | The source's `live_revision_id` at that moment, or null when the collection keeps no revisions |
| `translation_origin`         | text    | What produced the current translatable content, such as `human` or `machine:deepl`   |

Every entry gets a `content_fingerprint`, sources included, so the state of a whole translation group can be derived from the rows of that group.

The migration adds the index `idx_{table}_translation_source_id`, following the foreign key convention. `SchemaRegistry` creates the same columns and index for new collections. `RESERVED_FIELD_SLUGS` gains the five names.

`translation_origin` is an open string of at most 64 characters matching `/^[a-z][a-z0-9_-]*(:[a-z0-9_.-]+)?$/`. The admin editor sends `human` when an editor saves, and EmDash's importers write `import:<importer>`, such as `import:wordpress`. Plugins and API clients choose their own values. `machine:<service>` is a documented convention, not a closed list.

### Translation state

EmDash derives a translation's state from its own row and its source's row, and never stores it:

| State            | Condition                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `untracked`      | `translation_source_id` is null                                                                       |
| `source-missing` | `translation_source_id` names no non-deleted entry in the same translation group                      |
| `current`        | `translation_source_hash` equals the source's `content_fingerprint`                                   |
| `outdated`       | any other case, including a null `translation_source_hash` or a source without a fingerprint yet       |

In a group listing, an entry with no source of its own reports `null` when another sibling uses it as a source, and `untracked` otherwise. The editor shows sources without a state badge.

### Writes the server maintains

Clients never send a fingerprint or a source hash.

- **Fingerprint.** Every repository write that changes an entry's columns recomputes `content_fingerprint` from the stored translatable values and writes it in the same statement. That covers create, update, publish, revision restore, duplicate, site-transfer import and the WordPress importers. On a collection with drafts, saving a draft revision leaves the fingerprint alone and publishing updates it. A source counts as changed when its live content changes, which is the content visitors read.
- **New translation.** A create with `translationOf` records that entry as the source in the create transaction, which already loads the source today. The admin, REST, MCP and the plugin `content.create` API all pass `translationOf`, so all of them get this. The new entry starts `outdated`, because the admin pre-fills it with the source's text and nothing has been translated yet. A client that creates an entry with finished translated text sends `markTranslationCurrent: true` in the same create, and the entry starts `current`.
- **Duplicate.** A duplicate starts a new translation group, so the copy gets no source and no origin.
- **Confirming a translation.** Create and update bodies accept `markTranslationCurrent: true`. The server reads the source in the same transaction and copies its current `content_fingerprint` and `live_revision_id`. On a collection with drafts, the server stages both values in the draft revision next to the text they confirm, the way it stages a slug change, and writes them to the columns when the draft is published. The confirmation therefore records the source the translator saw, even when the source changes again before the translation is published.
- **Changing the source.** Update bodies accept `translationSourceId`, either a sibling id or `null`. A sibling id must name a non-deleted entry in the same group and must not be the entry itself. A new source without `markTranslationCurrent` leaves the hash null, so the entry reads `outdated` until someone confirms it. `null` clears all three source columns.
- **Origin.** Create and update bodies accept `translationOrigin`, a string or `null`. The server applies one rule to every caller: when a write changes `content_fingerprint` and carries no `translationOrigin`, the server stores `null`. A write that leaves the fingerprint unchanged keeps the stored origin. The admin editor sends `translationOrigin: "human"` with every save. Plugin admin pages run under the same session but do not go through the editor, so a translation plugin's page records its own origin or none.
- **Synced fields.** `syncNonTranslatableFields` writes only non-translatable fields, so it changes no fingerprint and no state.
- **i18n disabled.** The server maintains fingerprints whether or not i18n is enabled, so a site that turns it on later starts from current fingerprints. No surface shows translation state while i18n is disabled.

Editing a translation does not confirm it. An outdated German entry stays outdated after a German edit until the edit carries `markTranslationCurrent`, because changing the German text says nothing about whether it now matches the English source. The admin offers the confirmation as its own action.

### Interfaces

**REST.** Content item responses gain two properties:

```ts
interface ContentTranslationSource {
	/** Id of the source sibling. */
	id: string;
	/** Source live revision this translation was last confirmed against, or null. */
	revisionId: string | null;
	state: "current" | "outdated" | "source-missing";
}

// Added to the existing content item response
translationSource: ContentTranslationSource | null;
translationOrigin: string | null;
```

`translationSource` is `null` for an untracked entry. Computing its `state` takes one indexed lookup of the source row and runs only on authenticated content API reads.

Each item in `GET /_emdash/api/content/{collection}/{id}/translations` gains `translationState` (`"current" | "outdated" | "source-missing" | "untracked" | null`) and `translationOrigin`. Both come from rows the endpoint already loads.

`GET /_emdash/api/content/{collection}` accepts `translationState=current|outdated|source-missing|untracked`. The filter requires `locale` and the `content:read_drafts` permission, and runs as a left self-join on `translation_source_id`.

`POST /_emdash/api/content/{collection}/track-translations` starts tracking existing translations (see [Compatibility and migration](#compatibility-and-migration)). It requires `content:edit_any`.

**`getTranslations()`.** `TranslationSummary` gains optional `translationState` and `translationOrigin`. `findTranslations()` already selects every column of the group, so this adds no query.

**Plugins.** `ContentCreateOptions` gains `translationOrigin` and `markTranslationCurrent`. The plugin `content.update(collection, id, data)` API gains an optional fourth argument, `ContentUpdateOptions`, with `translationOrigin`, `markTranslationCurrent` and `translationSourceId`. An unlabelled plugin write that changes translatable content clears the origin, as it does for every other caller. `ContentSaveHookDetails` for `content:beforeSave` and `content:afterSave` gains `translationOrigin`, so a hook can see what produced a save.

**MCP.** `content_create` and `content_update` accept the same inputs. `content_translations` returns state and origin for each sibling, and `content_list` accepts the `translationState` filter. The `content_update` description says that `markTranslationCurrent` asserts the translation matches the current source.

**CLI.** `emdash content track-translations --collection <slug>` calls the tracking endpoint. With `--refresh-fingerprints` it recomputes fingerprints without touching source hashes.

**Admin.** When i18n is enabled:

- The locale switcher shows each sibling's state with an icon and a label: Current, Outdated, Source deleted or Not tracked.
- The editor of an outdated translation shows a notice with two actions. Show source changes opens the source's revision history at the revision recorded at confirmation, so the editor can step through what changed since. It is hidden when no revision was recorded. Mark as current saves with `markTranslationCurrent: true`.
- The editor of an untracked translation offers Set source, which picks a sibling and confirms against it.
- Content lists gain a translation state filter next to the locale filter.
- The collection settings page offers Start tracking translations while no entry in the collection has a source.

All strings go through Lingui, icons carry accessible labels, the layout uses logical Tailwind classes, and no state is shown by color alone.

### Errors

| Code                         | Status | When                                                                                                                                                         |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`           | 400    | Invalid origin string, a source outside the group or the entry itself, `markTranslationCurrent` without a source, or `translationState` without `locale` |
| `TRANSLATION_SOURCE_MISSING` | 409    | `markTranslationCurrent` while the recorded source is deleted                                                                                                |

### Runtime differences

SHA-256 uses Web Crypto (`crypto.subtle.digest`), which Workers and Node 22 provide. SQLite, D1 and PostgreSQL store the columns as plain `text` and `integer`, and the state comparison is string equality, so no dialect needs special handling.

## Compatibility and migration

The change is additive. API clients that ignore the new response properties see no difference, and requests without the new inputs behave as before. Existing writes change in one way: a write that changes translatable content also updates `content_fingerprint` and can clear `translation_origin`. No existing client reads either column.

The migration is restartable. For each collection in `_emdash_collections` it adds each column and the index only when absent, so a retry after a lost D1 response skips the statements that completed. Old application code ignores the new columns during a rolling deploy. Site-transfer classifies the five columns in `CONTENT_TABLE_COLUMNS`, which its column coverage check requires. Source id, source hash, source revision id and origin transfer as fields, and `content_fingerprint` is derived on import. When an import rewrites an entry to a new id because of a collision, translations that name it as their source follow the same rewrite. A source revision id that does not survive the transfer is cleared.

The migration computes no fingerprints, because hashing every row of every content table would run into migration row limits on large D1 sites. Existing entries keep `NULL` in every new column, read as `untracked`, and gain a fingerprint on their next write.

Existing translations stay untracked until an operator starts tracking them from the collection settings page, the CLI or the endpoint. Tracking walks the collection in batches of `SQL_BATCH_SIZE`. For each group with a default-locale entry, it computes missing fingerprints and marks every other sibling as current against the default-locale entry and its live revision. Groups without a default-locale entry stay untracked. Tracking asserts that existing translations are up to date, so it runs only when someone asks for it.

Changing a field's `translatable` flag changes what the fingerprint covers. The schema handler then recomputes the collection's fingerprints in bounded batches, and translations whose recorded hash no longer matches read `outdated`, because they now have to cover different content.

Rollback: older code ignores the columns and leaves them in place. Entries written by the older version keep a stale `content_fingerprint` until their next write under the newer version, or until a fingerprint refresh runs.

## Security and privacy

- **Authorization.** `translationOrigin`, `translationSourceId` and `markTranslationCurrent` need the permission the write already needs: `content:edit_own` or `content:edit_any`. Tracking existing translations needs `content:edit_any`.
- **Untrusted input.** The origin is checked against a fixed pattern and length, stored as a value and rendered as text. Source ids are checked against the translation group inside the write transaction, so a caller cannot link entries across groups or collections.
- **Information exposure.** The translations endpoint already hides unpublished siblings from callers without `content:read_drafts`, and the state is computed after that filter. Those callers see `outdated` where others see `source-missing`, so a subscriber cannot learn that a hidden or deleted source exists. The list filter requires `content:read_drafts`.
- **Spoofing.** The origin is the writer's claim. Any writer, including a token holder, can label a manual edit `machine:deepl` or a machine translation `human`. The admin shows it as "Recorded as", and the revision author stays the audit record.
- **Privacy.** Origin strings name services, not people. Fingerprints are one-way hashes of content the caller can already read.

## Performance

- **Logged-out renders.** No new query. `getTranslations()` already loads the whole group, and the state is computed in memory. Public single-entry reads do not compute `translationSource.state`.
- **Translations endpoint.** No new query. Every sibling's source is in the group the endpoint already loads.
- **Writes.** One SHA-256 over the translatable values per content write, in memory. Creates with `translationOf` already load the source. `markTranslationCurrent` adds one indexed read of the source row, only on writes that set it.
- **Storage.** About 170 bytes per row for two fingerprints, two ids and a short origin, plus one index per content table.
- **Lists.** The state filter is a self-join on an indexed column and is only available to authenticated callers.

The implementation pull requests include the query-count snapshot diff. Any increase on a logged-out route blocks the merge.

## Failure handling

- Fingerprints are computed before the write and stored in the same statement. If hashing throws, the write fails through the existing error path and nothing is stored.
- A deleted source turns its translations `source-missing`. Restoring it from the trash returns them to `current` or `outdated` without further action. After a permanent delete they stay `source-missing` until an editor sets a new source or clears it.
- Tracking and fingerprint refresh run in bounded batches without stored progress. A rerun is safe because each batch writes only rows whose values change.
- Code outside the repository, such as a site script that writes through `getDb()`, leaves fingerprints stale. The state of those entries can be wrong until their next repository write or a fingerprint refresh. The internationalization guide documents this.

## Verification

- Unit tests for the canonical form: key order, `_key` removal, `null` and absent values, byte-exact strings and the `v1:` prefix.
- Integration tests on SQLite and PostgreSQL with `describeEachDialect`:
  - A create with `translationOf` starts `outdated`, and with `markTranslationCurrent` starts `current`.
  - A translation created from another translation follows its direct parent.
  - Publishing a changed source makes its siblings `outdated`. Saving a source draft does not.
  - `markTranslationCurrent` returns a translation to `current`.
  - Syncing non-translatable fields changes no state.
  - Deleting and restoring a source moves its translations to `source-missing` and back.
  - A source id from another group, or the entry's own id, is rejected.
  - A duplicated entry has no source.
- Origin tests: a write with `translationOrigin: "human"` stores it, an unlabelled write from any caller clears the origin, and a write without content changes keeps it.
- Draft tests: `markTranslationCurrent` on a draft stages the source fingerprint and revision, a later source change before publish does not move them, and publishing writes them.
- Authorization tests for the new inputs, the list filter and the masked `source-missing` state.
- A `tests/workerd` test against real D1 that reruns the migration after each completed statement.
- An upgrade test on a database with existing translation groups: every entry reads `untracked`, and tracking marks them `current`.
- A site-transfer round trip that keeps source links and recomputes fingerprints.
- Unchanged query-count snapshots for SQLite and D1 on logged-out routes.
- A Playwright test for the locale switcher states and Mark as current, also run in Arabic.

## Rollout and implementation

The work lands in four steps. Each step works without the ones after it:

1. **Recording.** The migration, the `SchemaRegistry` columns, fingerprints on every repository write, source recording on create, site-transfer classification, and state in the translations endpoint and `getTranslations()`.
2. **Writing.** `markTranslationCurrent`, `translationSourceId` and `translationOrigin` for REST, plugins and MCP, plus the list filter.
3. **Admin.** Locale switcher states, the outdated notice, Set source and the list filter.
4. **Existing content.** Start tracking translations in the admin, the endpoint and the CLI, plus a section in the internationalization guide for plugin authors.

No feature flag is needed, because untracked entries behave as they do today.

## Alternatives

- **Keep state in an ordinary content field.** Sites do this today. It needs a field in every collection and a client that keeps it up to date, and it cannot see source changes that someone else makes.
- **Compare `updated_at` or `version`.** Cheaper, but any save of the source would mark every translation outdated, including a status change or a byline edit. The source revision id is recorded so editors can see what changed.
- **Store a `stale` flag.** A source change would have to update every sibling, which turns one write into a write per locale and can drift after a partial failure. Comparing two stored fingerprints avoids both.
- **A separate `_emdash_translation_state` table.** Leaves content tables unchanged but adds a join or a query to every group lookup, including `getTranslations()` on public pages.
- **State per field now.** More precise, but it needs stable Portable Text block identity first and multiplies storage. The `v1:` prefix leaves room for a per-field form.
- **Leave it to plugins.** A plugin cannot cover every write path the same way (imports, MCP, REST, other plugins) and cannot extend the translations endpoint or `getTranslations()`.

## Drawbacks

- Five more system columns on every content table and five more reserved field slugs.
- Fingerprints are only as correct as the write paths that maintain them. Writes outside the repository leave them stale.
- The origin is self-reported and can be wrong.
- Existing sites see Not tracked everywhere until they start tracking, and some never will.

## Open questions

- Show source changes opens the revision history at the recorded revision. Should a later admin change let it compare the recorded source revision directly with the current one? The revision view compares each revision with the one before it today. This affects only the admin, not stored data or APIs.
