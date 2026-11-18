---
title: Conditional fields in plugin Portable Text blocks
type: feature-plan
status: proposed
authors:
  - Akshay Gugale (@akigugale)
discussion: null
created: 2026-11-18
---

# Conditional fields in plugin Portable Text blocks

## Problem and user case

A plugin's Portable Text block shows every field in its edit dialog, even when a field only matters for one value of another field. Showing fields that don't apply confuses editors and authors: they can't tell which fields to fill in, and plugin authors have to explain it in each label.

## Proposed behavior

A block field can set `condition`. The edit dialog shows the field only while the condition matches, and updates as the editor changes values.

The following block shows **Link URL** only while **Add link** is on:

```ts
fields: [
	{ type: "toggle", action_id: "has_link", label: "Add link" },
	{
		type: "text_input",
		action_id: "link_url",
		label: "Link URL",
		condition: { field: "has_link", eq: true },
	},
],
```

<!-- TODO: add the demo GIF here, or attach it to the design PR. -->

- `field` is another field's `action_id`. The condition sets either `eq` or `neq`.
- A `repeater` sub-field can set `condition` too. It names another sub-field of the same row, and each row follows its own values.
- A hidden field keeps its value and is saved with the block.
- Hidden fields skip validation.

## Goals

- Show only the block fields that apply to the current values.
- Work the same inside repeater rows.
- Never lose what an editor typed because a field was hidden.

## Non-goals

- Operators beyond `eq` and `neq`, or several conditions on one field.
- A repeater sub-field condition that names a field outside its row.

## Interfaces and compatibility

- Block fields and repeater sub-fields accept an optional `condition: { field, eq } | { field, neq }`, the same shape Block Kit form fields use.
- Stored content doesn't change.
- Blocks without `condition` behave as before.

## Errors and edge cases

- Hidden fields keep their values, so a renderer should check the controlling field, not whether a value exists.
- New repeater rows start empty and ignore `initial_value`. Use `neq` to show a field before a choice is made.
- A condition that names a missing field compares against `undefined`.

## Verification

- Fields show and hide with `eq` and `neq` as the controlling field changes.
- A hidden field that would fail validation doesn't block saving, and keeps its value.
- Two repeater rows with different values each show their own fields.
