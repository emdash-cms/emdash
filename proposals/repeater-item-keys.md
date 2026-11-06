---
title: Stable keys for repeater items
type: rfc
status: proposed
authors:
  - Leander Gilles (@LeanderG)
champion: Leander Gilles (@LeanderG)
sponsor: Daniel Mueller (@danielmlr)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4538
created: 2026-10-19
---

# Stable keys for repeater items

## Summary

Every repeater item gets a stable `_key` string. The admin editor keeps keys when it saves. `ContentRepository` fills in missing keys on every create and update, so keys don't depend on whether the write comes from the REST API, MCP, a plugin, or a seed, and site import does the same for the entries it writes. Missing keys are derived from the entry and the item's position, so a client that never sends keys back keeps the same keys while items stay in place. A forward-only migration backfills keys into existing entries, and revisions saved before the upgrade get the same derived keys when they're read.

## Problem and user case

Repeater items have no stored identity. The admin editor gives each item a temporary `_key` while it's open, then removes the key before saving. Stored values, API responses, and MCP results contain only the sub-field values, as the [field type reference](../docs/src/content/docs/reference/field-types.mdx) shows.

Without a stored key, nothing can tell which item is which across saves:

- Site code that renders repeater items has to use the array index as the component key. After an editor reorders or deletes items, frameworks reuse component state for the wrong item.
- The admin editor matches incoming items to its temporary keys by position. When the value changes from outside the editor, collapsed state follows the position instead of the item.
- Revision history has to guess which items correspond between versions. [Changes inside blocks and repeater fields in revision history](https://github.com/LeanderG/emdash/blob/design/revision-history-blocks-and-repeaters/proposals/revision-history-blocks-and-repeaters.md) pairs repeater items by identical content and then by position. Removing one item and editing its neighbor in the same save can read as an edit to the wrong item.
- Features that refer to one specific item across saves, such as editorial notes attached to a repeater item, have no stable identifier to point at. A position stops identifying the item as soon as items are reordered. This RFC doesn't build these features, but they depend on it.

Blocks fields don't have this problem. Every block carries a `_key` that the server assigns when the client doesn't send one, and the server uses it to match blocks to their stored versions.

Assigning keys only to new writes would leave every existing item without one until its entry is saved again, which can take years for archived content. Site code would need an index fallback indefinitely, so this RFC includes a backfill.

## Example

An MCP client creates an entry with a keyless repeater:

```json
"specifications": [
	{ "label": "Weight", "value": "1.2 kg" },
	{ "label": "Color", "value": "Black" }
]
```

EmDash stores and returns it with keys derived from the entry and each item's position:

```json
"specifications": [
	{ "_key": "rk1_5f0c9e2a7b4d1e8f3a6c0b9d2e7f4a1c", "label": "Weight", "value": "1.2 kg" },
	{ "_key": "rk1_c2e8a4f1b7d03e9c6a5f2b8d1e4c7a90", "label": "Color", "value": "Black" }
]
```

A later keyless update that changes the color to "Red" keeps both keys, because both items are still in the same position. An update that sends both items back in the opposite order, keys included, stores the same two keys in the new order.

An entry saved before the upgrade has the keyless value shown first. After the migration, the entry stores the keys shown above, and its draft and older revisions return the same key for the item in each position when they're read.

## Goals

- Give every repeater item a stable identifier that site code, the admin, and revision history can use.
- Assign keys on every write path, so `_key` doesn't depend on which client wrote the content.
- Keep keys stable for clients that never send them back, as long as items don't move.
- Give existing content keys without requiring editors to resave it.
- Keep every request that is valid today valid.

## Non-goals

- Requiring `_key` in requests. Clients that never send keys keep working.
- The stricter block rules, such as rejecting keyless updates to a field that already has items. Repeater items have no type or version for the server to protect.
- Using keys for single-item operations, such as restoring one repeater item or attaching an editorial note to it.
- Changing how revision history displays repeaters. The revision history plan can pair items by `_key` once keys exist.

## Detailed design

### Scope

The rules apply to repeater fields at the top level of a collection and to repeater fields inside block values. A repeater inside a block is identified by the block's `_key` and the repeater's sub-field slug in the block type version that the block stores in `_version`.

### Admin editor

`RepeaterField` keeps each item's `_key` when it calls `onChange`. Items without a key, and later items whose key repeats an earlier one, get a new random key. New items get a new random key. Items that arrive without keys reuse the editor's previous key at the same position, so typing doesn't remount the item.

### Valid keys

A valid `_key` is a string of 1 to 64 characters. Every other value, including numbers, empty strings, and longer strings, is treated as missing. Requests that send such values today keep succeeding, and the item gets a key in their place.

### Derived keys

A derived key is `rk1_` followed by the first 32 hexadecimal characters of the SHA-256 digest of:

- the entry's `translation_group`, or its `id` when `translation_group` is null;
- the repeater's path: the field slug, or for a repeater inside a block, the blocks field slug, the block's `_key`, and the sub-field slug; and
- the item's index in the array.

The components are joined with a NUL separator before hashing. Using the translation group gives an item the same key in every translation of the entry while it stays in the same position. The `rk1_` prefix marks the key as derived by the server and leaves room for a different derivation later. `crypto.subtle` provides SHA-256 in both Workers and Node.js.

### Assigning keys

For each repeater value, keys are assigned in two passes:

1. Every valid `_key` is kept, unless an earlier item in the same array already has that key. Later duplicates are treated as missing. Blocks reject duplicates instead, but clients that copy an item today would otherwise start failing.
2. Every item without a kept key gets its derived key. If another item in the array already uses that key, the item gets a new ULID instead.

A client that sends a keyless array on every update keeps the same keys for items that stay in the same position. Clients that reorder items and want keys to follow them send back the keys they read.

### Server write path

`ContentRepository` assigns keys on create and update, in the same step that normalizes blocks fields and after the entry's ID and translation group are known. Every write that goes through it gets keys: the REST API, MCP, plugin `ctx.content.create` and `ctx.content.update`, seeds, and revision restores. Keys in the request or seed are kept.

### Site import

Site import writes entries with its own SQL instead of through `ContentRepository`. The entry import step assigns keys with the same rules, using the imported entry's translation group or ID. Keys in the import package are kept, so a site exported after the upgrade imports with its keys unchanged.

### Revision reads

Revisions keep the data they were saved with. The code that reads revision data, for drafts, revision history, and preview, assigns derived keys to items without a valid key, using the translation group of the revision's entry. Revisions saved before the upgrade then return the same key for each position as the backfilled entry. Restoring a revision writes through `ContentRepository`, which stores the keys.

### Types and validation

- The repeater item schema already allows unknown properties. It accepts any `_key` value, and key assignment replaces values that aren't valid keys.
- Generated TypeScript types declare `_key?: string` on repeater items. It stays optional because an instance running the previous version can still write keyless items during a rolling deploy (see [Compatibility and migration](#compatibility-and-migration)).
- The schema API requires sub-field slugs to start with a lowercase letter, so `_key` can't collide with a sub-field defined through it.

### Backfill migration

The next migration adds a `_key` to every repeater item that lacks a valid one, in every row of every `ec_*` table whose collection has a repeater field, or a blocks field whose allowed or stored block type versions define a repeater field. It doesn't write to `revisions`, which get keys when they're read.

Each row is processed with the rules in [Assigning keys](#assigning-keys), using its `translation_group` or `id`.

The migration follows `079_datetime_normalization`:

- It reads rows in batches of 50, ordered by ID, and computes new values in JavaScript.
- Each write is a compare-and-swap that only matches the value it read. A row that changed between the read and the write is skipped, because the write path has already given it keys.
- It records its position in the `options` table after each batch and resumes from there after an interrupted run. Rows it has already processed have keys, so reprocessing them writes nothing.
- It registers in `CONTENT_SIZED_MIGRATIONS` with a row count of the content rows it can write. On a deployed Worker in auto mode, a site above the 5,000-row limit gets `MigrationRowLimitError` and must run `emdash migrate`.

The migration doesn't change `version`, `updated_at`, or authors, and it doesn't create revisions or audit entries. `_rev` tokens are derived from `version` and `updated_at`, so editors who have an entry open don't get a conflict.

A value that isn't valid JSON, isn't an array, or contains items that aren't objects is left unchanged. The migration logs the table, row ID, and field path and continues. A cosmetic backfill doesn't block an upgrade.

`down` does nothing. Removing keys would also remove keys that clients sent.

## Compatibility and migration

- Stored repeater values and API and MCP responses gain a `_key` string on each item. Existing fields don't change. Code that reads sub-fields by name is unaffected. Code that iterates over every property of an item, or validates items with a strict schema, sees one more property.
- Requests that send a `_key` that isn't a valid key, such as `_key: 5`, keep succeeding. The stored item gets a key in its place.
- The generated types gain an optional `_key`, so existing TypeScript code keeps compiling.
- During a rolling deploy, instances running the previous version can still save keyless items after the migration has processed their rows. Those items get keys the next time they're saved. The migration doesn't run again.
- An editor whose admin page loaded before the upgrade saves keyless items. The server derives the same keys the backfill gave each position, so keys only change for items the editor moved.
- The admin change ships in `@emdash-cms/admin`, and the server, migration, and type changes ship in `emdash`. Both need changesets. The `emdash` changeset calls out the backfill and the 5,000-row limit on Workers.
- The field type reference shows `_key` in the stored repeater shape. The Cloudflare deployment page already explains `emdash migrate` for sites over the row limit.

## Security and privacy

- Authorization doesn't change. Key assignment runs inside the existing create, update, and import operations after their permission checks.
- `_key` is client-controlled text like any string sub-field. Site code that renders it into HTML escapes it like any other field value.
- Derived keys come from entry IDs and translation groups, which the API already returns, and from positions. They reveal nothing new.
- The migration builds SQL with `sql.ref()` for table and column names after `validateIdentifier()`, and parameterizes every value.

## Performance

- Logged-out routes don't change. No reads or queries are added.
- The write path processes values that create and update already hold in memory, and uses the entry ID and translation group that they already have. It adds no queries.
- Revision reads get the entry's translation group in the query that already loads the revision. They add no round trips.
- Each item stores about 40 more bytes.
- Searchable repeater fields index the raw JSON, so each `_key` becomes a search term. The search index grows slightly, and searching for a key finds its entry. The migration's writes fire the search update triggers, so backfilled rows are reindexed.
- The migration writes each affected content row once, in batches. On large D1 sites this is a one-time write cost, and above the row limit it moves the work from the first Worker request to `emdash migrate`.

## Failure handling

- An interrupted migration resumes from its recorded position. The compare-and-swap writes and the "already has a valid key" check make reprocessing safe.
- On D1, a lost response for a completed batch is harmless: rerunning the batch finds keys and writes nothing.
- Rows the migration can't parse are logged and skipped. Operators can fix the data and save the entry, and the write path adds keys then.
- On a Worker above the row limit, the site returns 503 until an operator runs `emdash migrate`, as for any content-sized migration.

## Verification

- Admin component tests: stored keys survive edits, keyless items receive unique keys that stay stable across edits, and duplicate keys are replaced.
- Key assignment unit tests: valid keys are kept; missing, non-string, empty, and over-long keys get derived keys; later duplicates get derived keys; a derived key that collides with a kept key falls back to a ULID; translations of an entry derive the same keys.
- Write path tests for every supported dialect:
  - creating with keyless items stores a unique `_key` on each item;
  - a keyless update that doesn't move items keeps their keys;
  - updating with keys keeps them, including after a reorder;
  - a request with `_key: 5` succeeds and stores a valid key;
  - a repeater inside a block receives keys;
  - an MCP `content_create` with a keyless repeater returns keyed items;
  - plugin `ctx.content.create` and `ctx.content.update`, seeds, and revision restores store keys.
- Site import tests: keyless items receive derived keys, and keys in the package are kept.
- Revision read tests: a keyless revision returns the same keys as the backfilled entry for each position, for drafts and older revisions.
- Migration tests for every supported dialect:
  - keyless items in content rows receive their derived keys, and revisions are left unchanged;
  - valid existing keys are kept, and invalid and duplicate keys are replaced;
  - repeaters inside blocks are backfilled;
  - a run interrupted after any batch resumes and produces the same result;
  - a row changed between read and write is skipped;
  - malformed values are left unchanged and logged;
  - `version`, `updated_at`, and revision counts don't change;
  - the row count reported to `CONTENT_SIZED_MIGRATIONS` matches the rows written;
  - a site with more than 5,000 affected rows is refused in Worker auto mode.
- A type generation test for the optional `_key` on repeater items.
- A manual upgrade of a site with repeaters, blocks containing repeaters, translations, drafts, and revision history, followed by editing, reordering, and restoring a revision.

## Rollout and implementation

1. Admin: keep keys in `RepeaterField`.
2. Key assignment in `ContentRepository`, request validation, and generated types.
3. Key assignment in site import.
4. Derived keys in revision reads.
5. Backfill migration, registered in `CONTENT_SIZED_MIGRATIONS`.

All five ship in the same release. The write path has to be deployed with the migration, or content written after the migration would be keyless again. No feature flag. The revision history plan can then pair repeater items by `_key`.

## Alternatives

- **Write path only, no backfill.** Avoids writing every affected row and the row-limit refusal on large Workers sites. Site code would need an index fallback until every entry has been resaved.
- **Random keys for missing keys.** Simpler, but a client that leaves out `_key`, as MCP and AI clients usually do, would get new keys on every save, and an entry's row and its revisions would disagree on every key.
- **Keys derived from item content.** Would follow an unchanged item across a reorder in old revisions. Identical items would collide and need a tiebreaker, and an edited item would get a different key in each revision. Position-derived keys match how the admin and revision history pair keyless items today.
- **Keys added on read for entries.** Site code reads entries on every request, and keys derived on read are no better than the index. Entry keys have to be stored so that they can follow items across reorders. Revisions are different: they never change, and deriving their keys on read gives the same result as storing them.
- **Backfilling revisions too.** Full histories push sites over the 5,000-row auto-mode limit quickly, and stored keys in revisions would equal the keys derived on read.
- **Lazy backfill on save or in the background.** Spreads the cost, but adds work to request paths, and nobody can tell when a site is fully keyed.
- **An opt-in CLI command.** Sites that don't run it stay mixed, so site code still needs a fallback.

## Drawbacks

- Large sites on Workers can't upgrade through auto mode and must run `emdash migrate`.
- The migration writes every affected entry row once.
- Derived keys follow positions. A keyless client that reorders items moves each key to whichever item takes its position, and in revisions saved before the upgrade, an item that moved between versions has a different key in each version.
- Items written by the previous version during a rolling deploy stay keyless until they're saved again, so `_key` stays optional in the generated types.

## Open questions

- Should duplicate keys be rejected, matching blocks, instead of replaced?
