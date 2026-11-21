---
title: Dark mode variant for Block Kit media pickers
type: feature-plan
status: proposed
authors:
  - vance (@mvvmm)
discussion: https://github.com/emdash-cms/emdash/discussions/1877
created: 2026-11-16
---

# Dark mode variant for Block Kit media pickers

## Problem and user case

- Image fields support a dark variant (`options: { darkVariant: true }`). Images in plugin Portable Text blocks do not.
- Plugin block forms accept Block Kit elements only, so there is no native `image` field and no dark slot.
- Plugin authors with logo-heavy blocks cannot offer editable dark logos.
- Discussion #1877, point 2.

## Proposed behavior

New optional `dark_variant: boolean` (default `false`) on `media_picker`. Builder: `mediaPicker("logo", "Logo", { darkVariant: true })`.

```ts
{ type: "media_picker", action_id: "logo", label: "Logo", dark_variant: true }
```

Stored value, beside the primary:

```json
{ "logo": "/_emdash/api/media/file/a.png", "logo_dark": "/_emdash/api/media/file/a-dark.png" }
```

Editor:

- Once a primary is picked, "Add dark mode variant" appears below it.
- The variant card has Replace and Remove.
- Same `mime_type_filter` as the primary.
- Removing the primary removes the variant. Replacing it keeps the variant.
- Works as a top-level block field and as a repeater sub-field.

Site rendering, no core change:

```astro
<Image image={node.logo} darkVariant={node.logo_dark} />
```

## Goals

- Same editor experience as image-field dark variants.
- Existing `media_picker` values keep working unchanged.

## Non-goals

- A dark version on media library items.
- Making the dark slot required.
- Native `blocks` fields (already support `darkVariant`).
- Tracking dark URLs in media usage. Depends on #4240.

## Interfaces and compatibility

- `MediaPickerElement`: new optional `dark_variant`.
- `@emdash-cms/blocks`: new `darkVariantActionId()` helper and `mediaPicker` option `darkVariant`.
- Stored data: new sibling key `${action_id}_dark`, written only when `dark_variant` is on.
- Additive. No migration. Primary value stays a URL string.

## Errors and edge cases

- `dark_variant` must be a boolean, otherwise a validation error.
- `${action_id}_dark` colliding with another element's `action_id` in the same list is a validation error. Applies to top-level and repeater fields.
- A collision is not checked when `dark_variant` is off.
- A variant without a primary is not offered or shown.

## Verification

- Unit: builder output, boolean check, collision rejection (top level and repeater).
- Component: no slot without a primary; variant stored under `_dark`; replace keeps it; remove-primary clears both in one update; remove-variant clears only it.
- E2E: a plugin block round-trips and renders `emdash-image--light` and `--dark`.
- Manual: block dialog in LTR and Arabic.

## Open questions

- Sibling key (`_dark`) vs object value (`{ url, darkVariant }`). The object form is breaking for every consumer that reads a string.
- Fixed suffix vs a plugin-chosen key.
- Feature plan or RFC? This adds a plugin-facing option and a stored-key convention.
