---
title: Nested repeaters in native block types and repeater fields
type: rfc
status: proposed
authors:
  - Diogo Carneiro (@diogoascarneiro)
champion: Diogo Carneiro (@diogoascarneiro)
sponsor: To be confirmed
discussions:
  - https://github.com/emdash-cms/emdash/discussions/5050
created: 2026-11-23
---

# Nested repeaters in native block types and repeater fields

## Summary

Let a repeater sub-field be another repeater, up to two levels deep, in both native block types (a collection's `blocks` field) and collection-level `repeater` fields. Both use one recursive sub-field model, so the schema API, MCP, seed files, validation, media tracking, datetime and URL handling, site transfer and the admin editor all follow the same rule.

Nested repeaters are defined through seed files, the REST API and MCP. The admin field editor can also add them to collection repeater fields. Editors fill in nested rows everywhere a repeater is edited. Block types have no admin editor, so they stay API, MCP and seed only.

## Problem and user case

A repeater is a list of rows, and a row can hold single values only. A row cannot hold its own list. Shapes that need one come up on marketing, pricing and documentation pages:

- FAQ groups, each with questions
- Navigation or footer groups, each with links
- Rate cards: categories that hold products, each with rates
- Pricing plans, each with groups of included features

Today the workarounds all cost editors something:

- **Flatten into numbered fields** (`feature1`, `feature2`). The number of rows is fixed when the schema is written.
- **Store a list as text**, one item per line, and split it when rendering. The marketing template does this: its pricing `features` and the Text and image `points` checklist are multiline text because repeaters cannot nest ([`templates/marketing/AGENTS.md`](../templates/marketing/AGENTS.md)). A stray line break becomes an item, and per-item fields are impossible.
- **Join sibling lists by ID.** Editors type matching IDs by hand, and a typo silently hides content.

The same shapes are the case made for plugin Portable Text blocks in [Discussion #3001](https://github.com/emdash-cms/emdash/discussions/3001) and its design pull request [#4979](https://github.com/emdash-cms/emdash/pull/4979), where the Block Kit `repeater` gets the same two-level limit. This RFC applies that rule to the native side so the two surfaces behave alike.

Sites built on native blocks that need these shapes flatten them, split text on line breaks, or join lists by ID. The marketing template's own workaround would also benefit from this update, and plugin Portable Text blocks have the same gap.

## Example

A block type for rate cards, created through the schema API, MCP or a seed file:

```json
{
	"slug": "rate_cards",
	"label": "Rate cards",
	"fields": [
		{
			"slug": "categories",
			"label": "Categories",
			"type": "repeater",
			"validation": {
				"subFields": [
					{ "slug": "label", "label": "Category", "type": "string", "required": true },
					{
						"slug": "products",
						"label": "Products",
						"type": "repeater",
						"maxItems": 10,
						"subFields": [
							{ "slug": "name", "label": "Product", "type": "string", "required": true },
							{
								"slug": "rates",
								"label": "Rates",
								"type": "repeater",
								"subFields": [
									{ "slug": "metric", "label": "Metric", "type": "string" },
									{ "slug": "price", "label": "Price", "type": "string" },
									{ "slug": "link", "label": "Link", "type": "url" }
								]
							}
						]
					}
				]
			}
		}
	]
}
```

The same `subFields` array works under a collection `repeater` field's `validation`.

The stored value is plain arrays in rows:

```json
{
	"_type": "rate_cards",
	"categories": [
		{
			"label": "Storage",
			"products": [
				{ "name": "R2", "rates": [{ "metric": "Storage", "price": "$0.015 / GB" }] },
				{ "name": "KV", "rates": [] }
			]
		}
	]
}
```

In the editor, an open category shows its name field and a Products list. An open product shows its Rates list. Each list adds, removes and reorders only its own rows.

## Goals

- One recursive sub-field model, shared by native block types and collection repeaters.
- A depth limit of two nested levels, enforced on write and fail-closed on read.
- Nested image, datetime and URL sub-fields get the same normalization, media-usage tracking, URL safety and validation as top-level ones.
- Edit nested rows in the existing admin editors, with `minItems` and `maxItems` applied to each list.
- No database migration and no change to how existing data is stored.

## Non-goals

- An admin editor for block types, which does not exist today. Nested repeaters in block types are defined through the API, MCP and seed files.
- A third nesting level.
- New sub-field types inside repeaters, such as `portableText`, `reference` or `file`.
- Nested lists inside plugin Portable Text blocks. That is the Block Kit work in #3001.
- Stored `_key` values for nested rows. That belongs to the stable-keys design (#4272); see [Related designs](#related-designs).
- Fixing deep links and keyboard reordering inside block lists. See [Known limits of the prototype](#known-limits-of-the-prototype).

## Detailed design

### Sub-field shape

A nested repeater is a flat sub-field. `subFields`, `minItems` and `maxItems` sit on the sub-field itself, not under `validation`:

```ts
interface RepeaterListSubField {
	slug: string;
	type: "repeater";
	label: string;
	required?: boolean;
	subFields: RepeaterSubField[];
	minItems?: number;
	maxItems?: number;
}
```

`RepeaterSubField` becomes `ScalarRepeaterSubField | NestedRepeaterSubField`. The types recurse exactly twice (`NestedRepeaterSubField`, then `InnermostRepeaterSubField` whose sub-fields are scalar), so a third level is also a type error for callers.

A nested repeater accepts only those keys. Unknown keys such as a misplaced `validation` or `options` are rejected, not stripped, so part of a definition cannot be dropped silently. Single-value sub-fields keep their current leniency: unknown keys are stripped, and collection fields are not checked beyond what they are today.

### Depth limit

`MAX_REPEATER_NESTING = 2` counts the repeaters that enclose a repeater sub-field. The field's own list counts as one. A repeater sub-field is valid when fewer than three repeaters enclose it, so `field → products → rates` is valid and `field → products → rates → tiers` is not.

The error is `Repeaters can be nested only 2 levels deep`, reported at the offending sub-field's `type` path. REST, seed validation, block-type validation and the registry all use the same helper in `packages/core/src/schema/repeater-sub-fields.ts`.

### Where the model is read

| Surface | Behavior |
| --- | --- |
| REST and MCP schema input | Recursive zod schema; a third level fails at `...subFields[n].type`. `schema_create_field` gains the `repeater` type and `validation.subFields`. |
| Seed validation and export | Seeds are checked with the same rules. Export rewrites nested `image` values to `$media`. |
| Block types | Validation and the compatibility diff recurse. Narrowing options, removing a field or changing a type inside a nested repeater is a breaking change and creates a new version, as it does at the top level. |
| Content validation | The zod schema recurses. Issues use full paths such as `categories.0.products.1.rates.2.price`, and the admin names them "Price (Rates (Products (Categories, item 1), item 2), item 3)". |
| Media usage | Extraction walks nested image sub-fields and records paths like `categories[0].products[1].rates[2].icon`. Projection fingerprints include nested `subFields` only when present, so flat fingerprints do not change and nothing is rescanned. |
| Datetime and URL | Normalization and URL safety walk dotted paths such as `products.rates.link`. Persisted descriptors stay `string[]`. |
| Site transfer | Analysis checks nested URL sub-fields and reports the full path. |
| Image normalization | Collection and block repeaters normalize nested image values like top-level ones. |
| Generated types | Codegen emits nested array types. |

### Changing a stored sub-field

Collections have no versioning, so stored rows would be read through the wrong shape. Changing an existing collection sub-field between a single value and a list, at any depth, is rejected with `FIELD_TYPE_CHANGE_REQUIRES_MIGRATION`. Adding a new sub-field is allowed.

Block types do not get this rule. They already treat a type change as breaking and create a new version, so existing blocks keep the old version and data, and move only through an explicit `migrateBlocks` write.

### Admin

- `RepeaterField` renders a nested `RepeaterField` for a `repeater` sub-field. A new row seeds each nested list with `[]`.
- `BlocksField` renders nested lists recursively with the block list editors. Item lookups, focus requests and undo use list paths such as `categories.0.products`. A list with a `repeater` sub-field always shows as expandable items.
- Client-side validation in `block-validation.ts` recurses and reports the outer item index that holds a nested problem.
- `FieldEditor` can add a `repeater` sub-field to a collection repeater field. The sub-field gets its own sub-field list and item limits, nested up to the same two levels, and the Repeater option disappears from the third level. A saved sub-field keeps its single-value or list nature: a saved repeater sub-field's type is locked, and a saved single-value sub-field cannot become a repeater, which matches the server rule above. New strings go through Lingui.

Admin layout reuses existing components and logical Tailwind classes (`border-s`, `ps-3`).

### Edge cases

- `minItems` and `maxItems` on a nested repeater apply to each row's list separately.
- Rows are stored without `_key`, at every level, as today.
- Locale: nested values belong to the row, so they follow the field's locale behavior. No new content-table queries.

## Compatibility and migration

This is additive. No migration. Existing fields and block types have no nested repeater, so their definitions, stored values and projection fingerprints do not change.

### Rollout order

Upgrade the server and the admin together, before any nested repeater is defined.

An older runtime reading a nested definition:

- **Collection field:** marks the field unsupported (`unsupportedType` at the nested `type` path) and refuses writes to it.
- **Block type:** records the nested repeater as an unsupported type in the stored version and refuses writes.

That is the same fail-closed path used for unknown field types, so an older runtime in a rolling deploy cannot rewrite nested data as a string. A new runtime fails the same way for a third level in stored JSON.

An older admin shows the nested rows through its generic repeater control only if the server sends them, but it cannot seed a new row's nested list with `[]` and may save `""`. Site code should treat a missing or non-array nested value as an empty list. Servers and admins ship in one release line, so this applies only to skew.

### Rolling back

Rolling the server back leaves nested data in place and unreadable by the older runtime (fail-closed, see above). Remove nested sub-fields before a rollback if editing must continue.

## Security and privacy

- Definitions are authorized as before: `schema:manage`. No new permission.
- Nested URL sub-fields get the same unsafe-scheme rejection as top-level ones, on content writes and in site transfer analysis.
- Definition JSON is untrusted input at the REST, MCP and seed boundaries. The recursive schema bounds depth at two levels, so a hostile definition cannot recurse without limit. Stored definitions are walked with the same bound.
- Nested image values use the existing media normalization and usage tracking. No new storage.
- No additional privacy surface.

## Performance

- No new queries on any route, logged in or out. Nested values live in the same JSON column or block value.
- Media-usage extraction walks nested image paths. The cost is proportional to nested rows and only applies to fields that declare nested image sub-fields.
- Content validation compiles a zod schema that grows with the definition. The depth cap bounds it.
- `pnpm query-counts` is unaffected, as no handler gains a query.

## Failure handling

- A write with an invalid nested value fails with `VALIDATION_ERROR` and per-path issues, as for top-level repeaters.
- A definition with a third level fails with `VALIDATION_ERROR` before anything is stored. Seed apply reports it in validation.
- A stored definition that this runtime cannot read marks the field or block type unsupported and refuses writes. Operators remove or upgrade the definition.
- Media normalization failures for a single nested image do not fail the save, matching today's repeater behavior.

## Verification

- Unit tests: recursive validator, depth error path, strict nested keys, lenient scalars, dotted path helpers, copy-on-write value mapping, datetime normalization in nested rows, media extraction paths, list-type-change detection, REST schema, block-type contract and compatibility diff.
- Integration tests on SQLite and PostgreSQL: create, read and validate two levels; full-path issues; nested `maxItems`; unsafe URL rejection; image normalization in collection and block repeaters; refusing a third level; refusing a single-value to list change; adding a nested sub-field.
- Admin component tests (browser): nested editing in `RepeaterField` and `BlocksField`, drag of nested rows, saved values exactly (`[]` for empty lists, no `_key`), nested validation issues and error naming, and `FieldEditor` creating a nested repeater, keeping a saved one, holding back an empty nested list, and not offering a third level.
- Manual: in the `simple` demo, a block type and a collection field nested two levels created through the REST API, edited in the admin; the REST API refused a third level.

A prototype with these changes is on [`diogoascarneiro/emdash@feat/native-nested-repeaters`](https://github.com/diogoascarneiro/emdash/tree/feat/native-nested-repeaters). It passes the root build, lint, typecheck, the full core suite and the admin suites.

## Related designs

### `proposals/blocks-field-redesign.md`

That plan lists "Lists inside list items" as a non-goal for its editing UI. This RFC changes that line: the editor presents nested lists with the rules for lists inside blocks, and a list with a `repeater` sub-field is always shown as expandable items. The design pull request updates the non-goal to point here.

### Stable keys for repeater items (#4272)

That design stores a `_key` on repeater items and backfills existing rows. Nested rows need the same treatment: the key assignment and the migration backfill must recurse into nested lists, with the nested path as part of the derived key. This RFC stores no keys, and works with or without #4272. If #4272 is accepted first, this RFC's implementation adds the recursion. If this RFC is accepted first, #4272 adds it.

### Revision history for blocks and repeaters (#4190)

That plan pairs repeater items by content and position because items have no stored keys. It should pair nested items the same way, and by `_key` once #4272 lands. This RFC adds no revision-history change; a nested list appears under its row like any other value.

## Rollout and implementation

1. Core: shared model, REST/MCP schemas, registry checks, block-type contract, content validation, media usage, datetime and URL handling, transfer, seed, export, codegen.
2. Admin: `RepeaterField`, `BlocksField`, `BlockListField`, validation, error naming, and the `FieldEditor` sub-field authoring form.
3. Docs: field types reference, blocks guide, seed files, the marketing template notes.
4. One changeset for `emdash` and `@emdash-cms/admin`.

No flag. The feature is inert until a nested definition exists.

## Known limits of the prototype

- The deep-link parser in `BlocksField` (`focusLinkedField`) rejects nested paths, so a link to a nested field opens the block but not the field.
- Error ordering ("next problem") ranks issues only to the top-level item and sub-field.
- Datetimes inside block repeaters are not normalized on the block write path. This was already the case for single-level block repeaters, and is not changed here.
- Keyboard reordering of list rows does not move a picked-up row, with or without nesting. That is a separate bug.

## Alternatives

- **Put `subFields` under `validation` on the sub-field**, mirroring the field level. It reads consistently but buries the shape one level deeper, and the Zod strictness that makes misplaced keys errors would be harder to express. The flat shape matches how a repeater sub-field is already written.
- **Allow any depth.** One more level has no shape in practice and narrows the editor. A hard cap keeps every walker and zod schema bounded.
- **Rows with a `json` field.** No per-item editing, validation or media tracking.
- **Separate collections joined by a reference field.** Heavier for data that belongs to one entry and loses ordering and atomic edits.
- **Block-level nesting (blocks inside blocks).** A different feature, already excluded from block definitions.

## Drawbacks

- A wider definition surface to keep consistent across about fifteen readers of sub-fields.
- The field editor's sub-field form grows a nested list inside a sub-field card, which is dense on narrow screens. Block types still need seeds, REST or MCP.
- Older runtimes lose write access to a field or block type once it defines a nested repeater, so the upgrade order matters.
- Nested media and URL fields add checks on every write to such fields.

## Open questions

- Should rejecting a single-value to list change also apply to block types? The prototype applies it to collections only, because block types create a new version for breaking changes. Both are defensible; this RFC keeps collections only for now.
- Is a depth of two the right cap, or should it be a constant that can grow later without a schema change? It is a constant today, so raising it is additive.
- Which design lands first, this one or stable keys (#4272), and who owns the recursion in the backfill?
