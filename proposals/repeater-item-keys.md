---
title: Stable keys for repeater items
type: rfc
status: proposed
authors:
  - Leander Gilles (@LeanderG)
champion: Leander Gilles (@LeanderG)
sponsor: TBD
discussions: []
created: 2026-10-19
---

# Stable keys for repeater items

## Summary

Every repeater item gets a stable `_key` string. The admin editor keeps keys when it saves. The server fills in missing keys on every create and update, whether the request comes from the REST API, MCP, or a seed. A forward-only migration backfills keys into existing content and revisions, so items saved before the upgrade have keys too.

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

EmDash stores and returns it with keys:

```json
"specifications": [
	{ "_key": "01JB7X6Q4N2K8M5R3T9V0W1Y2Z", "label": "Weight", "value": "1.2 kg" },
	{ "_key": "01JB7X6Q4P3M9N6S4V0W1X2Y3A", "label": "Color", "value": "Black" }
]
```

A later update that sends both items back in the opposite order, keys included, stores the same two keys in the new order.

An entry saved before the upgrade has the keyless value shown first. After the migration, the entry, its draft, and its older revisions all store the same key for the item in each position:

```json
"specifications": [
	{ "_key": "rk1_5f0c9e2a7b4d1e8f3a6c0b9d2e7f4a1c", "label": "Weight", "value": "1.2 kg" },
	{ "_key": "rk1_c2e8a4f1b7d03e9c6a5f2b8d1e4c7a90", "label": "Color", "value": "Black" }
]
```

## Goals

- Give every repeater item a stable identifier that site code, the admin, and revision history can use.
- Assign keys on every write path, so `_key` doesn't depend on which client wrote the content.
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

### Server write path

On create and update, after request validation and in the same step that normalizes blocks fields, the server processes every repeater value in the request:

- A `_key` that is a non-empty string is kept.
- A missing `_key` gets a new ULID.
- A `_key` that is present but isn't a non-empty string fails with `VALIDATION_ERROR`, naming the item's path, as it does for blocks.
- A `_key` that repeats an earlier item's key in the same field gets a new ULID. Blocks reject duplicates instead, but clients that copy an item today would otherwise start failing.

A client that sends a keyless array on every update gets new keys on every save. Clients that want stable keys send back the keys they read.

The same processing runs when a seed is applied. Keys in the seed are kept.

### Types and validation

- The repeater item schema already allows unknown properties. It adds `_key` as an optional non-empty string.
- Generated TypeScript types declare `_key?: string` on repeater items. It stays optional because an instance running the previous version can still write keyless items during a rolling deploy (see [Compatibility and migration](#compatibility-and-migration)).
- The schema API requires sub-field slugs to start with a lowercase letter, so `_key` can't collide with a sub-field defined through it.

### Backfill migration

The next migration, `092_repeater_item_keys` at the time of writing, adds a `_key` to every repeater item that lacks a valid one. It covers:

- every row of every `ec_*` table whose collection has a repeater field, or a blocks field whose allowed or stored block type versions define a repeater field; and
- every row of `revisions` for those collections, including drafts and older versions.

Backfilled keys are derived from the entry instead of generated at random, so an entry's row, its draft, and its older revisions agree on each item's key. The migration computes each key as `rk1_` followed by the first 32 hexadecimal characters of the SHA-256 digest of:

- the entry ID (`id` in `ec_*` tables, `entry_id` in `revisions`);
- the repeater's path: the field slug, or for a repeater inside a block, the blocks field slug, the block's `_key`, and the sub-field slug; and
- the item's index in the array.

The components are joined with a NUL separator before hashing. The `rk1_` prefix marks the key as backfilled and leaves room for a different derivation later. `crypto.subtle` provides SHA-256 in both Workers and Node.js.

Items keep any `_key` that is already a non-empty string and unique within the array. The migration treats every other `_key`, including duplicates after the first occurrence, as missing.

The migration follows `079_datetime_normalization`:

- It reads rows in batches of 50, ordered by ID, and computes new values in JavaScript.
- Each write is a compare-and-swap that only matches the value it read. A row that changed between the read and the write is skipped, because the write path has already given it keys.
- It records its position in the `options` table after each batch and resumes from there after an interrupted run. Rows it has already processed have keys, so reprocessing them writes nothing.
- It registers in `CONTENT_SIZED_MIGRATIONS` with a row count of the content rows and revisions it can write. On a deployed Worker in auto mode, a site above the 5,000-row limit gets `MigrationRowLimitError` and must run `emdash migrate`.

The migration doesn't change `version`, `updated_at`, or authors, and it doesn't create revisions or audit entries. `_rev` tokens are derived from `version` and `updated_at`, so editors who have an entry open don't get a conflict.

A value that isn't valid JSON, isn't an array, or contains items that aren't objects is left unchanged. The migration logs the table, row ID, and field path and continues. A cosmetic backfill doesn't block an upgrade.

`down` does nothing. Removing keys would also remove keys that clients sent.

## Compatibility and migration

- Stored repeater values and API and MCP responses gain a `_key` string on each item. Existing fields don't change. Code that reads sub-fields by name is unaffected. Code that iterates over every property of an item, or validates items with a strict schema, sees one more property.
- The generated types gain an optional `_key`, so existing TypeScript code keeps compiling.
- During a rolling deploy, instances running the previous admin can still save keyless items after the migration has processed their rows. Those items get keys the next time they're saved. The migration doesn't run again.
- An editor who loaded an entry before the migration and saves it afterwards sends the admin's random keys, which replace the backfilled keys once.
- The admin change ships in `@emdash-cms/admin`, and the server, migration, and type changes ship in `emdash`. Both need changesets. The `emdash` changeset calls out the backfill and the 5,000-row limit on Workers.
- The field type reference shows `_key` in the stored repeater shape. The Cloudflare deployment page already explains `emdash migrate` for sites over the row limit.

## Security and privacy

- Authorization doesn't change. The write path runs inside the existing create and update handlers after their permission checks.
- `_key` is client-controlled text like any string sub-field. Site code that renders it into HTML escapes it like any other field value.
- Backfilled keys are derived from entry IDs, which the API already returns, and from positions. They reveal nothing new.
- The migration builds SQL with `sql.ref()` for table and column names after `validateIdentifier()`, and parameterizes every value.

## Performance

- Logged-out routes don't change. No reads or queries are added.
- The write path processes values that create and update already hold in memory, and uses entry data that update already loads. It adds no queries.
- Each item stores about 40 more bytes.
- The migration writes each affected content row and revision once, in batches. On large D1 sites this is a one-time write cost, and above the row limit it moves the work from the first Worker request to `emdash migrate`.

## Failure handling

- An interrupted migration resumes from its recorded position. The compare-and-swap writes and the "already has a valid key" check make reprocessing safe.
- On D1, a lost response for a completed batch is harmless: rerunning the batch finds keys and writes nothing.
- Rows the migration can't parse are logged and skipped. Operators can fix the data and save the entry, and the write path adds keys then.
- On a Worker above the row limit, the site returns 503 until an operator runs `emdash migrate`, as for any content-sized migration.

## Verification

- Admin component tests: stored keys survive edits, keyless items receive unique keys that stay stable across edits, and duplicate keys are replaced.
- Write path tests for every supported dialect:
  - creating with keyless items stores a unique `_key` on each item;
  - updating with keys keeps them, including after a reorder;
  - a duplicate key is replaced on the second item;
  - an empty or non-string `_key` fails validation;
  - a repeater inside a block receives keys;
  - an MCP `content_create` with a keyless repeater returns keyed items.
- Migration tests for every supported dialect:
  - keyless items in content rows and revisions receive keys, and an entry's row and revisions agree on each position's key;
  - valid existing keys are kept, and invalid and duplicate keys are replaced;
  - repeaters inside blocks are backfilled;
  - a run interrupted after any batch resumes and produces the same result;
  - a row changed between read and write is skipped;
  - malformed values are left unchanged and logged;
  - `version`, `updated_at`, and revision counts don't change;
  - the row count reported to `CONTENT_SIZED_MIGRATIONS` matches the rows written;
  - a site with more than 5,000 affected rows is refused in Worker auto mode.
- A type generation test for the optional `_key` on repeater items.
- A manual upgrade of a site with repeaters, blocks containing repeaters, drafts, and revision history, followed by editing, reordering, and restoring a revision.

## Rollout and implementation

1. Admin: keep keys in `RepeaterField`.
2. Core write path, request validation, and generated types.
3. Backfill migration, registered in `CONTENT_SIZED_MIGRATIONS`.

All three ship in the same release. The write path has to be deployed with the migration, or content written after the migration would be keyless again. No feature flag. The revision history plan can then pair repeater items by `_key`.

## Alternatives

- **Write path only, no backfill.** Avoids writing every affected row and the row-limit refusal on large Workers sites. Site code would need an index fallback until every entry has been resaved.
- **Random keys in the backfill.** Simpler, but an entry's row and its revisions would get different keys, so the first revision comparison after the upgrade would show every item as replaced, and restoring an older revision would replace every key.
- **Keys derived from item content.** Would follow an unchanged item across a reorder in old revisions. Identical items would collide and need a tiebreaker, and an edited item would get a different key in each revision. Position-derived keys match how the admin and revision history pair keyless items today.
- **Keys added on read.** Random keys would change on every request, and keys derived on read are no better than the index. Keys have to be stored.
- **Lazy backfill on save or in the background.** Spreads the cost, but adds work to request paths, and nobody can tell when a site is fully keyed.
- **An opt-in CLI command.** Sites that don't run it stay mixed, so site code still needs a fallback.

## Drawbacks

- Large sites on Workers can't upgrade through auto mode and must run `emdash migrate`.
- The migration writes every affected row and revision once.
- Backfilled keys follow positions. In revisions saved before the upgrade, an item that moved between versions has a different key in each version.
- Items written by the previous version during a rolling deploy stay keyless until they're saved again, so `_key` stays optional in the generated types.

## Open questions

- Who sponsors this RFC? An Ideas Discussion needs to be opened before the design PR.
- Should the server reuse stored keys by position when an update sends a keyless array? That keeps keys stable for clients that never send them back, but a reorder would move each key to whichever item takes its position.
- Should duplicate keys be rejected, matching blocks, instead of replaced?
- Should the backfill cover only each entry's row, live revision, and draft revision instead of every revision? That reduces the row count, but older revisions would stay keyless and revision history would keep its fallback pairing for them.
