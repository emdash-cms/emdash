---
title: Help text for content fields
type: feature-plan
status: proposed
authors:
  - Storm (@Stormster)
discussion: null
created: 2026-10-24
---

# Help text for content fields

## Problem and user case

A content field has a label and nothing else. The admin shows a description only on plugin and
settings forms. So when a field needs a word of guidance ("leave a blank line between paragraphs",
"pick Urgent for danger or a closure"), sites pack it into the label. I run EmDash for local
government sites, edited by town clerks rather than developers, and labels like "Full text, a
blank line between paragraphs" are hard to scan. A screen reader also reads the whole thing as the
field's name.

## Proposed behavior

A field's widget options take `helpText`, a sentence of guidance (the name the field-kit widgets
already use for their own help). The content editor shows it under the control, in the style of a
Kumo Field description, and links it to the control so screen readers announce it with the field.
A repeater sub-field takes `helpText` as its own property, because its `options` is a select's
choice list.

    {
      "slug": "severity",
      "label": "Severity",
      "type": "select",
      "validation": { "options": ["Urgent", "Advisory"] },
      "options": { "helpText": "Pick Urgent for danger or a closure, and Advisory for anything else." }
    }

## Goals

- Help shows under the control on every content field kind that renders one labelled control,
  and on repeater sub-fields.
- It is linked to the control: Kumo's Field description where the control has one, otherwise
  `aria-describedby` (a switch, the file picker, a repeater's Add buttons).
- It is never a placeholder, and it stays beside a length or range hint, also while that limit is
  broken (Kumo shows the error in place of the description).
- A field without help renders exactly as today.

## Non-goals

- Editing help text in the schema editor. It is set through seeds, the schema API and MCP; the
  editor keeps what is stored.
- Portable Text, the reference picker and blocks fields. Fields nested in blocks get help through
  the same renderer.
- Changing how plugin widgets show help. They already receive `options` and read `helpText`.

## Interfaces and compatibility

- Stored data: none new. `options` is already stored as JSON; repeater sub-fields are stored
  inside `validation`.
- Manifest: field descriptors gain an optional `helpText`. It is copied from `options.helpText`
  because a select's choice list replaces `options` in the manifest.
- Schema API: a repeater sub-field accepts an optional `helpText` (today Zod strips it).
- Types: `FieldWidgetOptions.helpText`, `RepeaterSubField.helpText`,
  `ManifestFieldDescriptor.helpText`, and the admin's `FieldDescriptor.helpText`.
- Older admins ignore the new property; sites that set nothing see no change.

## Errors and edge cases

- Blank or non-string help is ignored, and surrounding whitespace is trimmed.
- The help element's id is derived from the field id (`field-<slug>-help`), so ids stay unique
  per form; the file picker falls back to `useId` when it has no id.

## Verification

- Core: the manifest publishes `helpText` for a string, a select and a repeater sub-field, and
  omits blank help; the schema API keeps a sub-field's `helpText`.
- Admin: each control's accessible description is its help text (string, select, textarea,
  datetime, switch, file picker, repeater sub-fields and Add buttons); help and a length hint
  both stay in the description while the limit is broken; a field without help has no
  description; the schema editor keeps a sub-field's help text on save.

## Open questions

- Is a feature plan enough? The change adds an optional property to the manifest field descriptor
  and to the schema API's repeater sub-field. It is additive and stores nothing new, but if
  Maintainers count it as a public API change, it becomes an RFC.
