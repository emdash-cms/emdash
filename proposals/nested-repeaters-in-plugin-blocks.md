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
- Comparison cases, each with labelled rows
- Timelines whose steps have sub-steps
- Spec sheets, each section with its own name and value pairs

Plugin authors have two workarounds today, and both hurt editors:

- **Flatten the list** into numbered fields such as `row1_label`, `row2_label` and `row3_label`. This fixes the number of rows when the block is declared, silently limits the content, and gives editors a long form with no grouping.
- **Store the region as HTML**, which only a developer can edit.

The `RepeaterSubField` type and the `validateBlocks` allow-list both reject a nested `repeater`. The admin form already renders each repeater row's fields through the same component as the top level, so it would render a nested repeater. The type and the allow-list are what stop it.

## Proposed behavior

A repeater's sub-field can be another repeater, one level deep. For example, a plugin declares FAQ groups like this:

```ts
import { elements } from "@emdash-cms/blocks";

const groups = elements.repeater("groups", "Groups", [
	elements.textInput("title", "Group title"),
	elements.repeater(
		"questions",
		"Questions",
		[
			elements.textInput("question", "Question"),
			elements.textInput("answer", "Answer", { multiline: true }),
		],
		{ itemLabel: "question", maxItems: 5 },
	),
]);
```

In the block's editing dialog, each group row shows its title field and its own Questions list. The nested list has the same controls as a top-level repeater: an add button labelled with its `item_label`, a remove button per row, collapsible rows and drag handles. Each list reorders only its own rows. Dragging a question moves it within its group and leaves the groups in place.

The block stores each nested list as an array in its row:

```json
{
	"_type": "faq.groups",
	"groups": [
		{
			"title": "Billing",
			"questions": [{ "question": "How do I pay?", "answer": "By card." }]
		},
		{ "title": "Accounts", "questions": [] }
	]
}
```

A new row starts its nested list as an empty array. Rows are saved without `_key`, the same as top-level repeater rows today. The plugin's own site component renders the data, as it does for any repeater.

## Goals

- Let a plugin Portable Text block declare one level of repeater inside a repeater, with TypeScript types and `validateBlocks` both enforcing that limit.
- Edit nested lists in the existing block dialog with the same controls as a top-level repeater, including `min_items` and `max_items` applied to each row's list.
- Store nested lists as plain arrays, with no `_key` and no change to how existing blocks are stored.

## Non-goals

- Repeaters nested two or more levels deep. One level covers the shapes above and keeps the dialog readable.
- Native block types used by a collection's `blocks` field, and collection-level `repeater` fields. They share the core `RepeaterSubField` model in `emdash`, and about 15 server helpers read their sub-fields one level deep, including validation, media usage, datetime and URL normalization, transfer and seed export. The [blocks field redesign](blocks-field-redesign.md) also lists lists inside list items as out of scope. That work needs its own RFC.
- Repeaters in sandboxed plugin admin page `form` blocks, which remain unsupported.
- Other new sub-field types inside repeaters, such as `portable_text` or a list of blocks.
- Counting media picked in plugin block data as used ([#3208](https://github.com/emdash-cms/emdash/issues/3208)). Nested rows are no worse off than top-level rows.
- Keyboard reordering of repeater rows in the block dialog. In testing, a picked-up row does not move with the arrow keys, with or without nesting. That needs a separate bug fix.

## Interfaces and compatibility

### `@emdash-cms/blocks`

- New type `ScalarRepeaterSubField`: the five sub-field types allowed today.
- New type `NestedRepeaterElement`: a `RepeaterElement` whose fields are `ScalarRepeaterSubField`.
- `RepeaterSubField` becomes `ScalarRepeaterSubField | NestedRepeaterElement`.
- `RepeaterElement` gains a type parameter for its fields, defaulting to `RepeaterSubField`. Existing references to `RepeaterElement` keep their meaning.
- `elements.repeater()` becomes generic over its fields, so a nested `elements.repeater()` call type-checks and a third level does not.
- `validateBlocks` accepts `repeater` as a sub-field of a top-level repeater. It validates the nested repeater like any repeater: `fields` present and non-empty, `min_items` and `max_items` non-negative integers, with `min_items` no greater than `max_items`, and each sub-field valid.

Plugin code that switches exhaustively over `RepeaterSubField["type"]` sees a new `"repeater"` member and may need a new case. No runtime behavior changes for existing blocks.

### `@emdash-cms/admin`

The block dialog seeds a new row's nested repeater with `[]`. Today it seeds every sub-field type it doesn't know with `""`. Nothing else in the admin changes, and the dialog adds no new strings. The add button and empty state already read the nested repeater's own `item_label` and label.

### `emdash`, stored data and the server

None. Plugin block data is stored in the Portable Text value as JSON, and the server does not check the shape inside a plugin block. Plugins pass their block definitions, including sandboxed plugins' JSON descriptors, to the admin unchanged.

### Older admin versions

A plugin that declares a nested repeater on an older admin still gets the nested list in the dialog. The older admin saves a new row's untouched nested list as `""` instead of `[]`. Plugin site components should treat a missing or non-array value as an empty list. Plugins that need the clean shape can require the `@emdash-cms/admin` release that ships this change.

## Errors and edge cases

- **Two levels deep:** `validateBlocks` reports `Repeaters can be nested only one level deep` at the inner element's `type` path, for example `blocks[0].elements[0].fields[0].fields[0].type`. The TypeScript types reject the same declaration.
- **Invalid nested definitions:** errors inside a nested repeater use the full path, such as `blocks[0].elements[0].fields[0].min_items`.
- **Limits:** `min_items` and `max_items` on a nested repeater apply to each row's list separately. The add and remove buttons follow them the same way they do at the top level.
- **Stored non-list values:** a nested value that isn't an array, for example after a plugin changes a sub-field's type, shows the existing notice offering to replace it with an empty list. Blank strings render as an empty list.
- **Item keys:** each list adds temporary `_key` values while the dialog is open and removes them from the rows it saves. Nested rows are saved without `_key`.
- **Reordering outer rows:** a nested list keeps its rows, open state and edits when its parent row moves.

## Verification

- Unit tests for `validateBlocks`: one nesting level is valid; a second level is rejected with the path and message above; errors inside a nested repeater report full paths.
- A browser component test of the block dialog: add groups and nested rows, save, reload, edit a nested row, drag a nested row with the pointer, and check the saved value exactly. That includes `[]` for an empty nested list, no `_key` in rows, and the outer order unchanged after a nested drag. With the `[]` seeding removed, the test fails because it receives `""`.
- Manual check in the `simple` demo with a test plugin declaring the FAQ groups block above: insert it from the slash menu, fill it, save the post, reload, reorder questions, and compare the stored value from the content API.
- Check the dialog in Arabic for nested-row layout and drag handle placement.

A prototype covering the types, validation, admin seeding, tests, docs and changeset is on [`diogoascarneiro/emdash@feat/nested-block-kit-repeaters`](https://github.com/diogoascarneiro/emdash/tree/feat/nested-block-kit-repeaters). It passes the root build, typecheck and lint, the `@emdash-cms/blocks` tests, and the admin editor tests.

## Open questions

- Does this need an RFC? It adds to the plugin-facing Block Kit types, but the change is additive, opt-in, and limited to the authoring dialog, with no stored-data or server change. Recommendation: a feature plan.
- Should nesting stay at one level? Recommendation: yes. Deeper nesting can be proposed later without breaking this design, because the limit is enforced by the type and validator, not by stored data.
- When a row's only text input is inside its nested list, the collapsed row reads "Item N". Should it show a count such as "3 questions" instead? Recommendation: leave it for a follow-up. Plugins can put a `text_input` first to get a readable summary.
