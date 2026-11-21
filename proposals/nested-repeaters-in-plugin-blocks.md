---
title: Nested repeaters in plugin Portable Text blocks
type: feature-plan
status: proposed
authors:
  - Diogo Carneiro (@diogoascarneiro)
discussion: https://github.com/emdash-cms/emdash/discussions/3001
created: 2026-11-19
---

# Nested repeaters in plugin Portable Text blocks

## Problem and user case

A plugin's Portable Text block describes its editing form with Block Kit elements. `repeater` is the only element that captures a list, and its sub-fields are limited to `text_input`, `number_input`, `select`, `toggle` and `media_picker`. A block can't hold a list whose items each have their own list.

That shape is common on marketing and documentation pages:

- FAQ groups, each with its own questions
- Navigation groups, each with its own links
- Rate cards: categories that hold products, each with its own rates
- Pricing plans, each with groups of included features

Plugin authors have three workarounds today, and all of them hurt editors:

- **Flatten the list** into numbered fields such as `stat1Label`, `stat2Label` or `detailGroup1Items`. This fixes the number of rows when the block is declared, silently limits the content, and gives editors a long form with no grouping.
- **Store the list as text**, one item per line, and split it when rendering. Editors lose per-item fields, and a stray line break becomes an item.
- **Use sibling lists joined by IDs**, such as a Products list where each product names its category's ID. Editors have to type matching IDs by hand, and a typo silently hides content.

A production marketing site on EmDash uses all three across its plugin blocks. Of the eight list-in-list shapes it fakes today, six need one level of nesting. Two need two levels: rate cards (category → product → rate) and pricing plans (plan → feature group → feature).

The `RepeaterSubField` type and the `validateBlocks` allow-list both reject a nested `repeater`. The admin form already renders each repeater row's fields through the same component as the top level, so it would render a nested repeater. The type and the allow-list are what stop it.

## Proposed behavior

A repeater's sub-field can be another repeater, up to two levels deep. For example, a plugin declares rate cards like this:

```ts
import { elements } from "@emdash-cms/blocks";

const categories = elements.repeater("categories", "Categories", [
	elements.textInput("label", "Category name"),
	elements.repeater(
		"products",
		"Products",
		[
			elements.textInput("name", "Product name"),
			elements.repeater(
				"rates",
				"Rates",
				[
					elements.textInput("metric", "Metric"),
					elements.textInput("price", "Price"),
					elements.textInput("unit", "Unit"),
				],
				{ itemLabel: "rate" },
			),
		],
		{ itemLabel: "product" },
	),
]);
```

In the block's editing dialog, each category row shows its name field and its own Products list, and each product row shows its own Rates list. A nested list has the same controls as a top-level repeater: an add button labelled with its `item_label`, a remove button per row, collapsible rows and drag handles. Each list reorders only its own rows. Dragging a rate moves it within its product and leaves the products and categories in place.

The block stores each nested list as an array in its row:

```json
{
	"_type": "pricing.rateCards",
	"categories": [
		{
			"label": "Storage",
			"products": [
				{
					"name": "R2",
					"rates": [{ "metric": "Storage", "price": "$0.015", "unit": "per GB-month" }]
				},
				{ "name": "KV", "rates": [] }
			]
		}
	]
}
```

A new row starts each nested list as an empty array. Rows are saved without `_key`, the same as top-level repeater rows today. The plugin's own site component renders the data, as it does for any repeater.

## Goals

- Let a plugin Portable Text block nest repeaters up to two levels deep, with TypeScript types and `validateBlocks` both enforcing that limit.
- Edit nested lists in the existing block dialog with the same controls as a top-level repeater, including `min_items` and `max_items` applied to each row's list.
- Store nested lists as plain arrays, with no `_key` and no change to how existing blocks are stored.

## Non-goals

- Repeaters nested three or more levels deep. No shape found in practice needs a third level, and each level narrows the dialog's fields.
- Native block types used by a collection's `blocks` field, and collection-level `repeater` fields. They share the core `RepeaterSubField` model in `emdash`, and about 15 server helpers read their sub-fields one level deep, including validation, media usage, datetime and URL normalization, transfer and seed export. The [blocks field redesign](blocks-field-redesign.md) also lists lists inside list items as out of scope. That work needs its own RFC.
- Repeaters in sandboxed plugin admin page `form` blocks, which remain unsupported.
- Other new sub-field types inside repeaters, such as `portable_text` or a list of blocks. Blocks whose rows need rich text, such as tabs and carousels, still need that separate element.
- Counting media picked in plugin block data as used ([#3208](https://github.com/emdash-cms/emdash/issues/3208)). Nested rows are no worse off than top-level rows.
- Keyboard reordering of repeater rows in the block dialog. In testing, a picked-up row does not move with the arrow keys, with or without nesting. That needs a separate bug fix.

## Interfaces and compatibility

### `@emdash-cms/blocks`

- New type `ScalarRepeaterSubField`: the five sub-field types allowed today.
- New type `InnermostRepeaterElement`: a `RepeaterElement` whose fields are `ScalarRepeaterSubField`.
- New type `NestedRepeaterElement`: a `RepeaterElement` whose fields are `ScalarRepeaterSubField | InnermostRepeaterElement`.
- `RepeaterSubField` becomes `ScalarRepeaterSubField | NestedRepeaterElement`.
- `RepeaterElement` gains a type parameter for its fields, defaulting to `RepeaterSubField`. Existing references to `RepeaterElement` keep their meaning.
- `elements.repeater()` becomes generic over its fields, so nested `elements.repeater()` calls type-check up to two levels and a third level does not.
- `validateBlocks` accepts `repeater` as a sub-field of a repeater that is at most one level deep. It validates each nested repeater like any repeater: `fields` present and non-empty, `min_items` and `max_items` non-negative integers, with `min_items` no greater than `max_items`, and each sub-field valid.

Plugin code that switches exhaustively over `RepeaterSubField["type"]` sees a new `"repeater"` member and may need a new case. No runtime behavior changes for existing blocks.

### `@emdash-cms/admin`

The block dialog seeds a new row's nested repeater with `[]`. Today it seeds every sub-field type it doesn't know with `""`. Nothing else in the admin changes, and the dialog adds no new strings. The add button and empty state already read each nested repeater's own `item_label` and label.

### `emdash`, stored data and the server

None. Plugin block data is stored in the Portable Text value as JSON, and the server does not check the shape inside a plugin block. Plugins pass their block definitions, including sandboxed plugins' JSON descriptors, to the admin unchanged.

### Older admin versions

A plugin that declares nested repeaters on an older admin still gets the nested lists in the dialog. The older admin saves a new row's untouched nested list as `""` instead of `[]`. Plugin site components should treat a missing or non-array value as an empty list. Plugins that need the clean shape can require the `@emdash-cms/admin` release that ships this change.

## Errors and edge cases

- **Three levels deep:** `validateBlocks` reports `Repeaters can be nested only 2 levels deep` at the third repeater's `type` path, for example `blocks[0].elements[0].fields[0].fields[0].fields[0].type`. The TypeScript types reject the same declaration.
- **Invalid nested definitions:** errors inside a nested repeater use the full path, such as `blocks[0].elements[0].fields[0].min_items`.
- **Limits:** `min_items` and `max_items` on a nested repeater apply to each row's list separately. The add and remove buttons follow them the same way they do at the top level.
- **Stored non-list values:** a nested value that isn't an array, for example after a plugin changes a sub-field's type, shows the existing notice offering to replace it with an empty list. Blank strings render as an empty list.
- **Item keys:** each list adds temporary `_key` values while the dialog is open and removes them from the rows it saves. Nested rows are saved without `_key` at every level.
- **Reordering outer rows:** a nested list keeps its rows, open state and edits when a parent row moves.

## Verification

- Unit tests for `validateBlocks`: two nesting levels are valid; a third level is rejected with the path and message above; errors inside a nested repeater report full paths.
- Browser component tests of the block dialog:
  - One level: add groups and nested rows, save, reload, edit a nested row, drag a nested row with the pointer, and check the saved value exactly. That includes `[]` for an empty nested list, no `_key` in rows, and the outer order unchanged after a nested drag. With the `[]` seeding removed, the test fails because it receives `""`.
  - Two levels: build category → product → rate, save, drag rates within a product, and check the saved value exactly, including `[]` for a product with no rates.
- Manual check in the `simple` demo with a test plugin declaring an FAQ groups block (one level) and a rate cards block (two levels): insert each from the slash menu, fill it, save the post, reload, reorder the deepest rows, and compare the stored value from the content API.
- Check the dialog in Arabic for nested-row layout and drag handle placement at every level.

A prototype covering the types, validation, admin seeding, tests, docs and changeset is on [`diogoascarneiro/emdash@feat/nested-block-kit-repeaters`](https://github.com/diogoascarneiro/emdash/tree/feat/nested-block-kit-repeaters). It passes the root build, typecheck and lint, the `@emdash-cms/blocks` tests, and the admin editor tests.

## Open questions

- Does this need an RFC? It adds to the plugin-facing Block Kit types, but the change is additive, opt-in, and limited to the authoring dialog, with no stored-data or server change. Recommendation: a feature plan.
- Is two levels the right limit? Recommendation: yes. Rate cards and pricing plans need two levels, nothing found needs three, and three nested lists still leave usable field widths in the dialog. The limit lives in the type and validator, not in stored data, so it can be raised later without breaking existing blocks.
- When a row's only text input is inside its nested list, the collapsed row reads "Item N". Should it show a count such as "3 rates" instead? Recommendation: leave it for a follow-up. Plugins can put a `text_input` first to get a readable summary.
