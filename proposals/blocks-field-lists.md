---
title: "Blocks field: lists inside blocks"
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-14
---

# Blocks field: lists inside blocks

This is the third of three plans for the admin's `blocks` field. It covers `repeater` fields inside blocks, which this plan calls lists. It builds on [Blocks field: scannable block list](blocks-field-block-list.md) and [Blocks field: content-first field layout](blocks-field-layout.md).

## Problem and user case

Most marketing blocks hold a list. On the marketing template's Home page, Logo wall has 6 logos, Features has 6 features, Stats has 4 stats, Testimonials has 3 quotes and FAQ has 5 questions. Every list renders the same way, whatever it holds:

- Each item is a bordered card inside the block, with a header, a red trash icon, and every sub-field as a labelled box. A list with one sub-field, such as a list of client names, is a stack of cards with one input each.
- A stat is two short values, such as "23%" and "Lower energy spend, on average", but it still takes a card with two labelled boxes.
- `text` sub-fields are 3-row boxes, whatever their length.
- An item's header shows its first `string` or `text` sub-field, so a testimonial reads as the start of its quote rather than the person who said it.
- "Add Item" sits above the list and always adds to the end. Removing an item takes effect immediately, with no undo.

## Proposed behavior

Try it in the [interactive mockup](https://emdash-blocks-field-mockup.gifted-paperback.workers.dev/?site=halden&notes=on). Notes 6, 8, 12 and 13 cover this plan. The marketing template has no list with a single sub-field, so the type-in list is shown on the mockup's Norma page, a portfolio Home page built with blocks; switch pages with the mockup's toolbar.

### Three ways to show a list

The admin picks one from the list's sub-fields.

1. **Type-in list:** exactly one sub-field, of type `string` or `url`, for example a list of client names. Items are bulleted lines you type into:
   - Enter adds a line after the current one.
   - Backspace on an empty line removes it and moves to the line above.
   - The up and down arrow keys move between lines.
   - A blank line exists only in the editor. It isn't part of the saved value, so autosave never sends it, and leaving the list removes it.
2. **Table:** up to three sub-fields, all short (`string`, `url`, `number`, `integer`, `select` or `image`), with at most one image. Stats (Value, Label) and Logo wall (Company name, Logo) are tables.
   - Each item is a row and each sub-field a column, with the sub-field labels as column headers.
   - An image column shows a thumbnail cell that opens the media picker.
3. **Expandable items:** every other list, including Features, Testimonials, FAQ and Pricing plans.
   - A closed item shows its title, up to two more values as a muted summary, and a thumbnail when it has a photo, for example "Maya Okafor · Director of Facilities · Calder University". An item's title is its first `string` sub-field that is neither a link field nor a button's text paired with a link field by name (such as `cta_label` with `cta_url`), or else its first `text` sub-field. This rule matches the block list plan's.
   - Opening an item lets you edit its title right in the item's row. The other sub-fields follow, laid out by the field layout plan, and the open item sits on a soft grey fill instead of between lines.
   - A photo inside an item shows as a settings row with a thumbnail, Replace and Remove. A `{image}_caption` sub-field inside an item is an ordinary one-line text field; captions only sit under photos at the block level.

### In every list

- The list's label shows how many items it has, for example "Features 6".
- Hovering an item shows a drag handle and a `⋯` menu with Move up, Move down and Delete. Expandable items also have Duplicate. Keyboard users move items with Move up and Move down.
- Deleting an item shows a toast with Undo, which works like the block list plan's toast.
- "Add item" sits at the end of the list. A new expandable item opens with its title focused. A new table row focuses its first cell.
- A red dot marks a closed item with a sub-field that failed validation, as the field layout plan marks closed blocks.
- On touch screens and phone-width screens, the `⋯` menu stays visible, and Move up and Move down replace dragging.

## Goals

- Short lists are as compact as what they hold: a line per name, or a row per stat.
- Long items stay scannable when closed and readable when open.
- Editors can reorder, duplicate and delete items without dragging, and undo a deletion.
- Typing into a list never saves an accidental blank item.
- Everything works with a keyboard, a screen reader, right-to-left languages and phone screens.

## Non-goals

- Top-level `repeater` fields on collections. They keep their current cards. A later plan can bring them in line.
- Lists inside list items. Repeater sub-fields can't be repeaters, and that doesn't change.
- New sub-field types, such as a list of strings inside an item. Pricing plan features stay one per line in a text area.
- A thumbnail grid for lists that hold only images.

## Interfaces and compatibility

- No changes to stored data, the API or the block type schema. List values keep their shape. Repeater items are stored without `_key`, as today; the admin keeps its own keys while editing, for drag, undo and focus.
- The presentation comes from each list's existing sub-field definitions. Adding a fourth sub-field, or a `text` sub-field, to a table's block type turns that list into expandable items.
- Lists inside blocks get a new presentation of the repeater editor. Top-level repeater fields keep using the current one.
- New UI strings go through Lingui. Lists use list semantics, and tables use table, row and cell roles, so screen readers announce their structure.
- The implementation ships with an `@emdash-cms/admin` changeset.

## Errors and edge cases

- **Read-only:** the same presentation with nothing editable: no menus, drag handles or Add item, no Enter or Backspace handling, and no blank-line removal.
- **At `maxItems`:** Add item is hidden, as it is today. Enter in a type-in list adds nothing, and Duplicate is disabled.
- **At `minItems`:** Delete is disabled. Today the trash icon is hidden instead. Blank lines that would leave a type-in list short of `minItems` still aren't saved, and the field layout plan's validation reports the missing items.
- **No `string` sub-field that can be the title:** the title is the item's first `text` sub-field, shown as the start of its text in the closed row. The row has no editable title, and every sub-field is edited in the item's body.
- **Empty title:** a closed item reads "Untitled", and the editable title shows the sub-field's label as its placeholder.
- **Required sub-fields:** an invalid sub-field turns red where it is, in a table cell or an open item, and a closed item gets a red dot, following the field layout plan's validation rules.
- **Undo:** only the latest deletion can be undone, while its toast is showing, as with blocks.
- **Narrow fields:** tables keep their columns down to phone width. Expandable items stack their side-by-side fields.
- **Right-to-left languages:** bullets, carets, drag handles and table columns mirror.

## Verification

Unit tests for choosing the presentation from sub-fields: one `string` or `url` sub-field, short tables with and without an image, a second image, and a `text` sub-field.

Browser tests for lists inside a block, using a test block type with a one-sub-field list for the type-in cases:

- In a type-in list, Enter adds a line after the current one, Backspace on an empty line removes it, and the arrow keys move between lines.
- Blank lines never reach the field's value, and leaving the list removes them.
- Table cells edit their sub-field, and an image cell opens the media picker.
- An open item's title edits its title sub-field and updates the closed summary.
- Move up, Move down, Duplicate and Delete with Undo keep item values and order.
- `maxItems` and `minItems` disable the right actions.
- Read-only lists ignore Enter and Backspace and offer no menus.
- Right-to-left layout and keyboard-only use.

Manual checks: the marketing template's Home and Pricing pages, and a block type with a one-sub-field list such as the mockup's Clients. Check each at desktop widths of 1280 and 1440 px and at a phone width of 375 px, in Arabic, in dark mode, and with a screen reader.

## Implementation

One implementation pull request, stacked on the field layout one. It adds the block-field presentation of the repeater editor, connects it in `BlocksField.tsx`, and adds tests.

## Open questions

- Should pasting several lines into a type-in list add one item per line? Recommendation: yes. It makes moving a list in from a document a single paste.
- Should a list with a single image sub-field show a thumbnail grid instead of a one-column table? Recommendation: yes, in a follow-up plan.
