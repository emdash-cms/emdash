---
title: Searchable blocks fields
type: feature-plan
status: proposed
authors:
  - Adam Lowe (@adamslowe)
discussion: null
created: 2026-11-07
---

# Searchable blocks fields

## Problem and user case

A `blocks` field is the only way to give editors rich text inside a multi-column or sectioned layout: a block type can carry `portableText` sub-fields, while a Portable Text plugin block can only take Block Kit inputs. The schema registry rejects `searchable: true` on a `blocks` field, and the full-text search extractors never look inside one. A site that models its page or post body as a blocks field has no body text in `search()`, in the `/_emdash/api/search` route, or in the admin's entry search.

Site builders are pushed to choose between a single rich-text column that is searchable and a flexible layout that is not. Issue [#3670](https://github.com/emdash-cms/emdash/issues/3670) describes a law-firm site where every page body is a `layout` blocks field and site search of body text is a requirement.

## Proposed behavior

A blocks field accepts `searchable: true` like a `portableText` field does.

```ts
{ slug: "layout", type: "blocks", searchable: true, validation: { allowedTypes: ["prose", "two_column"] } }
```

- The prose of every Portable Text sub-field in every block is indexed, at any depth, together with image `alt` and `caption` and code block text. An entry whose only body text lives inside a block is found by `search()` for a word in that text, and the snippet shows prose rather than JSON.
- Structural tokens of the stored JSON (`_type`, `_key`, block type slugs, `normal`, `span`, `markDefs`) are not indexed.
- Turning `searchable` on for an existing collection rebuilds the index from current content. Drafts stay out of results until published. Updates replace the indexed text, and soft deletes remove the entry.
- The admin field editor shows the Searchable switch when adding or editing a blocks field. When the switch is on, a note under it says that Portable Text content inside blocks is indexed.
- `extractSearchableFields()` takes an optional third argument, a map from field slug to field type, and walks blocks fields sub-field by sub-field when the map marks a field as `blocks`.

## Goals

- Let a page or post whose body is a blocks field be found by full-text search for words in its body.
- Reuse the existing Portable Text extraction so the sync triggers, `rebuildIndex`, `populateFromContent`, and the searchable toggle all behave the same for blocks as for Portable Text.
- Expose the setting in the field editor so it does not require a seed file, the API, or MCP.
- Document exactly which block content is indexed.

## Non-goals

- Indexing plain `string` and `text` sub-fields such as headings, labels, and link text through a schema-aware key list derived from the block type definitions. The SQL extractor keeps its fixed key list (`text`, `alt`, `caption`, `code`), so such sub-fields are indexed only when their slug is one of those keys. This is documented as a limitation.
- Passing field types through `@emdash-cms/plugin-ai-search`, whose `entryText` calls `extractSearchableFields` without the new map. A searchable blocks field yields empty text there until the plugin passes the collection's field types. This is a separate change to that plugin.
- Making a blocks field `required`, `unique`, or `indexed`, or giving it a custom widget. Those restrictions stay.
- Any change to the stored shape of a blocks value or to the FTS5 table layout.

## Interfaces and compatibility

- Schema: `searchable` is accepted on `blocks` fields through `createField`, `updateField`, seeds, the schema API, and MCP. No other field option changes.
- `extractSearchableFields(entry, fields, fieldTypes?)` gains an optional parameter. Existing callers are unaffected; without the map a blocks array is indistinguishable from Portable Text by shape and is treated as it is today.
- Full-text search: `FTSManager.searchValueExpr` applies its Portable Text `json_tree` extraction to `blocks` as well. The trigger, rebuild, and populate paths already share that expression, so no new SQL path is introduced.
- Migrations: migration `064_fts_plain_text.ts` carries a copy of the expression and is left as shipped. No searchable blocks field could exist when it ran, so there is no stored trigger to correct and nothing to backfill. A collection that turns `searchable` on for a blocks field gets fresh triggers from `FTSManager`.
- Postgres: FTS5 is SQLite-only and the Postgres path is a no-op today. Nothing changes there.
- Ships as a minor release of `emdash` and `@emdash-cms/admin` with one changeset. Existing schemas keep working; no default changes.

## Errors and edge cases

- A `NULL` blocks value indexes as `NULL`. An empty array makes the `group_concat` return `NULL`, matching Portable Text.
- A blocks value stored as a JSON string or as an array is handled uniformly on the SQL path because the backing column is `TEXT`. The JS extractor parses a string value and returns an empty string for invalid JSON.
- A `string` sub-field whose slug is `caption`, `alt`, `text`, or `code` is indexed by the SQL path. The JS extractor emits only Portable Text arrays, so it is narrower than SQL; the docstrings say so.
- Repeater rows are walked. A string `caption` sub-field inside a repeater row is indexed by SQL for the reason above; other string sub-fields in rows are not.
- The identifier interpolated into the SQL expression is validated by `FTSManager.validateInputs` before use, and the key list is a constant.
- The field editor keeps `required`, `unique`, and `indexed` hidden and forced off for blocks; only `searchable` is offered.

## Verification

- Registry: `searchable: true` is accepted on a blocks field; `required`, `unique`, `indexed`, and `widget` are still rejected.
- Integration, SQLite: an entry whose only body text is in a block's Portable Text sub-fields is found through `search()` for words in the prose block and in each column of a two-column block; structural tokens do not match; turning `searchable` on reindexes existing content; a draft is not found and is found after publish; an update swaps the old word for the new one; a soft delete removes the entry; a `caption` string sub-field is found while a `heading` string sub-field is not; a `caption` sub-field in a repeater row is found; a searchable `portableText` field still indexes and a non-searchable one does not.
- Unit: the blocks branch of `extractSearchableFields` extracts Portable Text sub-fields, skips `_`-prefixed keys and non-text values, handles string and invalid input, and leaves `portableText` and `string` fields unchanged.
- Admin: the field editor shows the Searchable switch for a blocks field, hides Required, shows the note when the switch is on, and saves `searchable: true`.
- Manual: in `demos/simple`, add a blocks field with the switch on and confirm the entry search finds a word from a block's prose.

A prototype against 1.0.1 was verified on D1 with a `pages.layout` blocks field, including draft, publish, update, soft delete, and toggle rebuild, as reported in [#3670](https://github.com/emdash-cms/emdash/issues/3670#issuecomment-5902788200). The implementation is in [#4739](https://github.com/emdash-cms/emdash/pull/4739).
