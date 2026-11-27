---
title: Dark mode variant for repeater image sub-fields
type: feature-plan
status: proposed
authors:
  - vance (@mvvmm)
discussion: https://github.com/emdash-cms/emdash/discussions/1877
created: 2026-11-23
---

# Dark mode variant for repeater image sub-fields

## Problem and user case

- Top-level image fields support a dark variant (`options: { darkVariant: true }`, #2609). `image` sub-fields in repeaters do not.
- Logo strips, feature icons, and cards are repeater rows. On one large marketing site, about 71% of image placements are repeater rows and about 22% are top-level image fields.
- Storage, write-time normalization, media usage, and `Image` from `emdash/ui` already handle `darkVariant` on a repeater row's image. Editors have no way to set it: there is no opt-in and no admin slot.
- The API schema strips an unknown `darkVariant` key from a sub-field, so a schema API write cannot opt in either.
- Discussion #1877, point 2. Repeater media pickers: #4440. Block Kit equivalent: #4891.

## Proposed behavior

New optional `darkVariant: boolean` (default `false`) on `RepeaterSubField`, valid only when `type` is `"image"`:

```json
{
	"slug": "logos",
	"label": "Logos",
	"type": "repeater",
	"validation": {
		"subFields": [
			{ "slug": "name", "label": "Name", "type": "string" },
			{ "slug": "logo", "label": "Logo", "type": "image", "darkVariant": true }
		]
	}
}
```

Stored row value, unchanged from what the runtime already accepts:

```json
{
	"name": "Acme",
	"logo": { "id": "01A", "provider": "local", "darkVariant": { "id": "01B", "provider": "local" } }
}
```

Editor:

- Once a row has a primary image, "Add dark mode variant" appears below it. Same component and UX as top-level image fields.
- Replacing the primary keeps the variant. Removing the primary removes both.
- Field editor: a **Dark mode variant** switch on each image sub-field. It is saved only while the sub-field is an image.
- Works in collection repeaters and in repeaters inside native block types.
- A block-type list whose image sub-field has the flag opens its items to edit them instead of showing a table, and the image runs full width in the item instead of a thumbnail settings row. A table cell or thumbnail row has no room for the variant slot.

Site rendering, no change:

```astro
{page.data.logos.map((row) => <Image image={row.logo} />)}
```

## Goals

- Same editor experience as image-field dark variants.
- Existing repeater definitions and values keep working unchanged.

## Non-goals

- A dark version on media library items.
- Making the dark slot required.
- Portable Text `image` nodes. Separate proposal.
- Block Kit `media_picker` (#4891).
- Changes to media usage tracking. Repeater rows already record `<path>.darkVariant` (#4240).

## Interfaces and compatibility

- `RepeaterSubField`: new optional top-level `darkVariant`. Shared by collection repeaters and block-type repeaters.
- Top-level key rather than `options`: a sub-field's `options` is already `string[]` holding a `select` sub-field's choices. Reshaping it would break every reader of `options`.
- API schemas (`createFieldBody`, `updateFieldBody`, block-type fields): keep the key instead of stripping it.
- Block types: the flag is part of the field contract. Turning it on changes the fingerprint and is a compatible change. Turning it off is a breaking change, the same as `options.darkVariant` on a top-level block image field.
- Seeds: collection and block-type sub-fields keep the key through apply and export.
- Stored data: no change, no migration.
- Additive.

## Errors and edge cases

- `darkVariant` on a sub-field that is not an `image` is a validation error in the schema API, block-type validation, and seed validation.
  - Rejecting, rather than ignoring, matches block-type validation, which already rejects `options` on a non-`select` sub-field and `options` on a non-image block field. It also surfaces a typo or a stale flag after a type change.
  - Compatibility: before this change the API stripped the key, so no API-written definition carries it. Block-type definitions already stored with an invalid flag stay readable: read-mode validation does not check it.
- `darkVariant` must be a boolean, otherwise a validation error.
- Changing an image sub-field to another type in the field editor drops the flag.
- A variant without a primary is not offered or shown.
- A stored `darkVariant` on a row whose sub-field has the flag off is kept and still rendered. The editor shows no slot for it.

## Verification

- Unit: API schemas keep the flag and reject non-boolean and non-image use; block-type validation, fingerprint, and compatibility; seed validation; seed apply and export keep it.
- Component: no slot without the flag or without a primary; variant stored under `row.<sub>.darkVariant`; replace keeps it; remove-primary clears both; field editor switch shown only for image sub-fields and saved only for them; block-type list item shows the slot.
- E2E: a repeater row with a variant saves and renders `emdash-image--light` and `--dark`.
- Manual: field editor and repeater row in LTR and Arabic.

## Open questions

- Top-level `darkVariant` vs reshaping `options`. Proposed: top-level, non-breaking.
- Reject vs ignore on non-image sub-fields. Proposed: reject.
- Block-type lists with the flag leave the table layout. An alternative is a variant control inside the table cell.
