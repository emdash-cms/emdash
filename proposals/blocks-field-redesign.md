---
title: "Blocks field redesign"
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-14
---

# Blocks field redesign

This plan redesigns the admin's `blocks` field in three parts: the list of blocks, the fields inside an open block, and the lists (`repeater` fields) inside blocks. It ships in three stacked implementation pull requests, one per part.

## Problem and user case

Editors build landing pages from blocks. The marketing template's Home page has nine: Hero, Logo wall, Features, two Text and image blocks, Stats, Testimonials, FAQ and Call to action. Opening that page shows all nine as open forms, one after another.

### The block list

- Every block is a bordered card with its whole form open. Reaching the FAQ means scrolling past every field of the seven blocks above it.
- Every block header has a "Version 1" badge, plus Duplicate and Delete buttons that are always visible. Each of the Home page's nine blocks shows a red trash icon before anyone asks to delete anything.
- Putting an FAQ above the call to action means adding it at the bottom of the page, then dragging it up.
- The picker is a panel of text buttons, and it always adds to the end. Block types can already store an icon, but the admin never shows it.
- Deleting a block takes effect immediately and autosave keeps the loss. Getting it back means restoring an older revision.

### Fields inside a block

Opening a block shows each of its fields as a labelled, bordered box in one column, in the order the block type defines them. The Hero block has 12 fields, and the form gives the editor little help reading them:

- The headline looks like every other field, so the form doesn't show what the block says.
- Every `text` field is a 10-row box with the placeholder "Enter markdown content...". A one-sentence subheadline takes the height of a paragraph.
- A button's text and its link are two separate full-width boxes. The Hero has three of these pairs: primary button, secondary button and announcement.
- Block fields have no help text, so the marketing seed writes instructions into labels, such as "Primary button link (starts with /, https://, mailto:, tel: or #)". Long labels wrap and push fields apart.
- Settings such as "Center the layout" and "Section ID" get the same weight as the headline.
- The admin doesn't check block fields before saving. An empty required field only shows up when the server rejects an autosave.

### Lists inside blocks

Most marketing blocks hold a list: Logo wall has 6 logos, Features has 6 features, Stats has 4 stats, Testimonials has 3 quotes and FAQ has 5 questions. Every list renders the same way, whatever it holds:

- Each item is a bordered card inside the block, with a header, a red trash icon, and every sub-field as a labelled box. A list with one sub-field, such as a list of client names, is a stack of cards with one input each.
- A stat is two short values, such as "23%" and "Lower energy spend, on average", but it still takes a card with two labelled boxes.
- `text` sub-fields are 3-row boxes, whatever their length.
- An item's header shows its first `string` or `text` sub-field, so a testimonial reads as the start of its quote rather than the person who said it.
- "Add Item" sits above the list and always adds to the end. Removing an item takes effect immediately, with no undo.

## Proposed behavior

Try it in the [interactive mockup](https://emdash-blocks-field-mockup.gifted-paperback.workers.dev/?site=halden&notes=on). Its numbered notes walk through each part: notes 1 to 4 and 7 to 9 cover the block list, notes 5, 10, 11, 14 and 15 the fields inside a block, and notes 6, 8, 12 and 13 the lists. The mockup's toolbar also shows the two field layouts that were considered and rejected: labels beside every field, and labels above every field.

Two terms are used throughout:

- A **link field** is a `url` field, or a `string` field whose slug ends in `_url`, `_link` or `_href`. The marketing seed's button links are `string` fields of this kind.
- An **item's title** is its first `string` sub-field that is neither a link field nor a button's text paired with a link field by name (such as `cta_label` with `cta_url`), or else its first `text` sub-field. An empty title reads "Untitled".

### 1. The block list

#### Closed blocks

- Blocks sit on one sheet, split by hairlines, instead of in separate cards.
- Existing blocks start closed when the edit screen opens. A closed block shows its icon, name and a one-line summary, plus a small thumbnail when the block has a photo.
- The summary is the block's first filled `string` or `text` field, preferring required fields. It skips link fields, the section ID (`anchor_id`), and text that only repeats the block's name. A block without such text lists the titles of its first list's items instead: a Clients block whose heading is just "Clients" reads "Hotel Wilde, Het Bouwhuis, Ola Ceramics +3".
- "Collapse all" and "Expand all" sit next to the field's label.
- An open block's header stays pinned to the top of the screen while you scroll through that block, so you can always see which block you're in and close it.
- A block you add opens with its first field focused. A duplicated block appears below the original, open.

#### Adding, moving and deleting

- Hovering a block shows a gutter outside the sheet, as in Notion. `+` adds a block below; Option-click or Alt-click adds one above. `⋮⋮` drags the block with a pointer. Clicking it, or pressing Enter or Space on it, opens the block's menu.
- Each block's `⋯` menu has Add block above, Add block below, Duplicate, Move up, Move down and Delete. The menu footer names the block type and its version, for example "Features · version 1".
- Keyboard users move blocks with Move up and Move down. They replace dragging with the keyboard, which the handle supports today.
- The picker opens next to where the block will go. It keeps today's search, category groups and descriptions, adds each block type's icon, and works with the arrow keys and Enter.
- "Add block" at the end of the sheet adds to the end.
- Deleting a block shows a toast with Undo, which puts the block back where it was. Retired, inactive-version and unsupported blocks ask for confirmation instead, because the server can't take them back once autosave has saved the deletion (see Interfaces and compatibility).
- Touch screens and phone-width screens have no room or hover for the gutter, so they hide it and show `⋯` on every row. Move up and Move down replace dragging there.

#### Block states

- The "Version N" badge moves into the menu footer.
- "Inactive version", "Retired" and "Unsupported" stay on the row as quiet tags, because they change what the editor can do. The mockup doesn't show these states.

#### Icons

- Rows and the picker show the block type's icon. A block type with no icon, or with a name that doesn't match a Phosphor icon, shows a generic block icon.
- The marketing template's 11 block types get icons, in both `templates/marketing` and `templates/marketing-cloudflare`.

### 2. Fields inside a block

An open block shows its content first, then its settings, then an Advanced row.

1. **Content.** One-line text (`string`), text areas (`text`), rich text, photos and lists run full width, each under a small label.
   - The block's headline reads as a heading, in larger semibold text. It's the first `string` or `text` field whose slug or label contains the word headline, heading, title or statement. A field whose slug or label contains the word label, eyebrow, kicker or tag is never the headline. Words match whole, with slugs split at underscores and labels at spaces and punctuation, so "subheadline" and "subtitle" don't count. When no field matches, the block's first `string` or `text` field is the headline, unless it's one of the excluded fields.
   - Two or three `string` fields in a row share a line, such as a pricing plan's Price and Period. They stack on narrow screens.
   - Photos span the block, with Replace and Remove on hover. A field named `{image}_caption` sits under its photo as the caption.
   - Text areas start one line tall and grow as you type.
2. **Settings.** Rows under a thin divider, each with its label at the start and its value at the end.
   - A button's text and its link share one row. Fields pair by name: `{base}_label`, `{base}_text` or `{base}` with `{base}_url`, `{base}_link` or `{base}_href`. The row is labelled with the text field's label minus a trailing "text", so "Primary button text" becomes "Primary button".
   - Switches, choices, numbers, dates, files, and link fields that aren't in a button row get one row each.
   - When the field is narrower than 440 px, each settings row puts its label above its value.
3. **Advanced.** A closed row at the end holds the section ID (`anchor_id`) and shows its value while closed.

Values stay quiet until you reach for them: no box at rest, a light fill on hover and a focus ring while editing. A field with a maximum length shows a character count while you type.

| Field type          | Shown as                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `string`            | One-line text in the content part; a link field gets a settings row |
| `text`              | Growing text area in the content part                               |
| `portableText`      | The existing rich text editor, full width in the content part       |
| `image`             | Full-width photo in the content part                                |
| `url`               | Settings row, or the link half of a button row                      |
| `boolean`           | Settings row with a switch                                          |
| `select`            | Settings row with a dropdown                                        |
| `multiSelect`       | Settings row with today's checkboxes                                |
| `number`, `integer` | Settings row with a number input                                    |
| `datetime`          | Settings row with today's date and time input                       |
| `file`              | Settings row with today's file control                              |
| `repeater`          | A list in the content part, as described in part 3                  |

The mockup's sample pages don't use `multiSelect`, `datetime` or `file` fields, so those rows aren't shown there.

#### Hints from labels

When a label ends in parentheses that contain a space, or in ", for example …", that part becomes the field's hint. "Primary button link (starts with /, https://, mailto:, tel: or #)" becomes the label "Primary button link" with the hint "Starts with /, https://, mailto:, tel: or #". Parentheses without a space stay in the label, so "Price (USD)" and "Size (px)" keep their units.

A hint shows:

- as the placeholder of an empty optional field, so "Checklist (one item per line)" reads "One item per line" until you type. The two halves of a button row keep their "Text" and "Link" placeholders instead;
- under the field while you type in it;
- as the error under a field whose value doesn't match the field's pattern.

#### Validation

- The admin checks block fields with the same rules the server applies:
  - a required field can't be missing or empty;
  - a value must match its field's pattern, length limits, number range and options, and a `url` value must be a safe link;
  - a list must stay within its `minItems` and `maxItems`;
  - a required sub-field of a list item can't be missing or empty.
- These are checks on the data, so they cover every field, however it's drawn. They never reject a value the server accepts: a value made only of spaces counts as filled, as it does on the server.
- A new block's switches start off, so a required switch is never missing.
- An empty required field reads "Required". After you leave it, or when you save or publish, it turns red. An empty required photo shows its empty state in red.
- A field whose value doesn't match its pattern shows its hint, or "Check the format" when it has none, as an error under the field.
- A list with too few or too many items shows the error under its label. The mockup doesn't show this error.
- A closed block or list item with an invalid field gets a red dot. Save and Publish open the first such block and focus the field.
- While a block field is invalid, autosave waits, as it does today for invalid URLs. A notice says autosave is paused and names the block and field. Clicking it opens the block and focuses the field, as Save does. Autosave resumes once the field is fixed, so a newly added block with an empty required field holds autosave until it's filled in.
- A newly added block shows no red errors until you touch one of its fields or save.

#### Right-to-left languages

Labels sit at the start, on the right, and values line up with their labels, even when the text in a value runs left to right.

### 3. Lists inside blocks

#### Three ways to show a list

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
   - A closed item shows its title, up to two more values as a muted summary, and a thumbnail when it has a photo, for example "Maya Okafor · Director of Facilities · Calder University".
   - Opening an item lets you edit its title right in the item's row. The other sub-fields follow, laid out as in part 2, and the open item sits on a soft grey fill instead of between lines.
   - A photo inside an item shows as a settings row with a thumbnail, Replace and Remove. A `{image}_caption` sub-field inside an item is an ordinary one-line text field; captions only sit under photos at the block level.

The marketing template has no list with a single sub-field, so the mockup shows the type-in list on its Norma page, a portfolio Home page built with blocks. Switch pages with the mockup's toolbar.

#### In every list

- The list's label shows how many items it has, for example "Features 6".
- Hovering an item shows a drag handle and a `⋯` menu with Move up, Move down and Delete. Expandable items also have Duplicate. Keyboard users move items with Move up and Move down.
- Deleting an item shows a toast with Undo, which works like the block toast.
- "Add item" sits at the end of the list. A new expandable item opens with its title focused. A new table row focuses its first cell.
- On touch screens and phone-width screens, the `⋯` menu stays visible, and Move up and Move down replace dragging.

## Goals

- An editor can see every block on a page, and what each one contains, without scrolling through forms.
- An editor can read what a block says from its open form, in the order the page shows it.
- Related fields sit together: a button's text with its link, and a photo with its caption.
- Short lists are as compact as what they hold, a line per name or a row per stat, and long items stay scannable when closed.
- An editor can add a block anywhere, and move, duplicate or delete blocks and list items without dragging. A deletion made by mistake can be undone on the spot.
- Instructions appear where they're needed: in the empty field, and under the field while typing.
- Invalid block fields, including list sizes and list items, are caught before autosave sends them, with the field and block marked. Typing into a list never saves an accidental blank item.
- Every existing block type works without a schema or template change. Fields that don't follow the naming conventions fall back to plain rows.
- Everything works with a keyboard, a screen reader, right-to-left languages, phone screens and dark mode.

## Non-goals

- A live preview beside the form, or clicking a block on the site to open it.
- Copy and paste between pages, saved presets, hiding a block without deleting it, and remembering which blocks were open after a reload.
- Preview images in the picker. That needs a new stored field on block types.
- Explicit layout settings on block fields, such as help text, groups or widths. They would change the block type schema and the API, so they need an RFC. The name-based rules in this plan would stay as the fallback for fields without settings.
- Letting drafts save blocks with empty required fields. The server rejects them on every save, and changing that is an API change for its own proposal.
- Top-level collection fields, including top-level `repeater` fields, which keep their current look.
- Lists inside list items, and new sub-field types such as a list of strings inside an item. Pricing plan features stay one per line in a text area.
- A thumbnail grid for lists that hold only images.
- Blocks inside the rich text editor (Portable Text blocks).

## Interfaces and compatibility

- No changes to stored data, the API, the block type schema, or how sites render blocks. Moving a block keeps its `_key`, `_type` and `_version`. List values keep their shape: repeater items are stored without `_key`, as today, and the admin keeps its own keys while editing, for drag, undo and focus.
- Undo adds a block back with the same `_key`, `_type`, `_version` and values. If autosave has already saved the deletion, the server treats the block as new, and it accepts new blocks only for allowed block types on their active version. That's why retired, inactive-version and unsupported blocks get a confirmation instead of Undo.
- `icon`, `description` and `category` already exist on block types. The admin resolves `icon` with the same Phosphor lookup it uses for collection and plugin icons (`resolveNavIcon`).
- The layout comes from each field's existing `type`, `slug`, `label`, `required` and `validation`. Field names and label words become layout signals: the pairing suffixes, `{image}_caption`, `anchor_id`, the headline words and label hints. The blocks guide (`docs/src/content/docs/guides/blocks.mdx`) gets a short section listing them as best-effort layout hints that may change, so developers can choose names that lay out well without treating them as a contract.
- A list's presentation comes from its sub-field definitions, so adding a fourth sub-field, or a `text` sub-field, to a table's block type turns that list into expandable items.
- Inside blocks, `BlocksField` places each nested field (content, settings row or Advanced) and asks the editor's field renderer for a quiet control without its own label. Lists inside blocks get a new presentation of the repeater editor. Top-level fields and top-level repeaters keep their current look. The `renderField` callback between `ContentEditor` and `BlocksField` is internal to `@emdash-cms/admin`.
- Quiet controls are the existing Kumo components and field controls with token-based class overrides: transparent border and background at rest, a fill on hover and a ring on focus. Kumo has no borderless input variant; the overrides can go if it gets one.
- Holding autosave for invalid block fields reuses the existing check that holds it for invalid URLs.
- Every site with a blocks field sees the new behavior: blocks start closed, Duplicate and Delete move into the menu, the version badge moves into the menu footer, and open blocks use the new layout. Each implementation pull request ships an `@emdash-cms/admin` changeset that says so.
- Sites already created from the marketing template keep their stored block types, which have no icons, and show the generic icon. The seed change only affects new sites.
- New UI strings go through Lingui. Layout uses logical properties, so it mirrors in right-to-left languages. Lists use list semantics, and tables use table, row and cell roles, so screen readers announce their structure.

## Errors and edge cases

### The block list

- **Read-only:** no gutter, menu or Add block. Blocks still open and close.
- **At `maxItems`:** every add action and Duplicate are disabled, and a tooltip gives the limit. Today Duplicate stays enabled at the limit.
- **Below `minItems`:** the existing "Add at least N blocks." message stays.
- **Retired, inactive-version and unsupported blocks:** Duplicate stays disabled for retired and unsupported blocks, as today. Moving and adding next to any of them still work. Deleting one asks for confirmation and offers no Undo. An unsupported block opens to the existing "This block cannot be edited" message instead of fields.
- **First and last block:** Move up is disabled on the first block and Move down on the last.
- **Undo:** only the latest deletion, of a block or a list item, can be undone, while its toast is showing. The toast is announced to screen readers and stays for 6 seconds. It pauses while the pointer is over it or focus is inside it, and it closes when you delete something else or leave the page. After that, restoring an older revision is the way back.
- **Site toolbar links:** `?field=content` still scrolls to the blocks field.
- **Long names and summaries:** the summary is cut off with an ellipsis. A block name too long for the row wraps, as it does today, so the row never overflows at 375 px.
- **Right-to-left languages:** the gutter sits on the right, menus open toward the end edge, and carets flip.

### Fields inside a block

- **Names that match no convention:** no button row, caption or Advanced row. Each field gets its own row, and nothing is hidden.
- **A unit or code in parentheses:** only parentheses that contain a space are split, so "Price (USD)", "Size (px)" and "Aspect ratio (16:9)" stay whole.
- **Labels in other languages:** parentheses split the same way. ", for example" and the headline words are only recognized in English. In other languages that text stays in the label, and the first-field rule picks the headline.
- **No headline candidate:** a block that starts with "Section label", such as Testimonials, has no field styled as a heading.
- **Half-filled button row:** the empty half shows its placeholder, "Text" or "Link".
- **Long values in settings rows:** cut off with an ellipsis until focused.
- **Unsupported field types:** keep the existing unsupported message.
- **Narrow fields:** below 440 px, settings rows stack their labels above their values, and side-by-side `string` fields stack too.
- **Read-only:** the same layout with controls disabled, and no validation markers.

### Lists inside blocks

- **Read-only:** the same presentation with nothing editable: no menus, drag handles or Add item, no Enter or Backspace handling, and no blank-line removal.
- **At `maxItems`:** Add item is hidden, as it is today. Enter in a type-in list adds nothing, and Duplicate is disabled.
- **At `minItems`:** Delete is disabled. Today the trash icon is hidden instead. Blank lines that would leave a type-in list short of `minItems` still aren't saved, and validation reports the missing items.
- **No `string` sub-field that can be the title:** the title is the item's first `text` sub-field, shown as the start of its text in the closed row. The row has no editable title, and every sub-field is edited in the item's body.
- **Empty title:** a closed item reads "Untitled", and the editable title shows the sub-field's label as its placeholder.
- **Required sub-fields:** an invalid sub-field turns red where it is, in a table cell or an open item, and a closed item gets a red dot.
- **Narrow fields:** tables keep their columns down to phone width. Expandable items stack their side-by-side fields.
- **Right-to-left languages:** bullets, carets, drag handles and table columns mirror.

## Verification

### The block list

Browser tests in `packages/admin/tests/components/BlocksField.test.tsx`:

- Blocks start closed. An added block opens with its first field focused, and a duplicated block opens below the original. Collapse all and Expand all change every block.
- The summary prefers a required headline. It skips link fields, the section ID and text equal to the block name, and falls back to item titles from the first list.
- Add block above and Add block below insert at the right position. Add block at the end appends.
- Enter or Space on the drag handle opens the menu. Move up and Move down keep each block's values and `_key`, and are disabled at the ends. The existing test that reorders from the keyboard drag handle changes to use the menu.
- Delete, then Undo, restores the block at the same position with the same `_key`. Deleting an inactive-version or retired block asks for confirmation and offers no Undo.
- At `maxItems`, every add action and Duplicate are disabled.
- Rows and the picker show the block type's icon, with the generic icon for a missing or unknown name.
- Read-only mode hides the gutter, the menu and Add block.

In `packages/admin/tests/components/BlocksField.layout.test.tsx`, the summary moves onto the block name's row, so the test that aligns it under the name changes. The long-name wrapping test still applies.

### Fields inside a block

Unit tests for the layout rules: button pairs for every suffix combination, captions, the Advanced row, headline selection with whole-word matching ("subheadline" isn't a headline, "Section label" is excluded), and hint splitting, including "(USD)" staying whole.

Unit tests for the client checks: a missing and an empty required value for each field type, patterns, list `minItems` and `maxItems`, required sub-fields, and a value made only of spaces passing.

Browser tests, extending `packages/admin/tests/components/BlocksField.layout.test.tsx`:

- An open Hero shows the headline as a heading, then the subheadline, then the photo and its caption, then the settings rows, and the section ID inside a closed Advanced row.
- Fields whose names match no convention render as separate rows.
- A hint shows as the placeholder of an empty optional field, under the field while focused, and as the error when the field fails its pattern. Button rows keep "Text" and "Link".
- Text areas grow with their content.
- A required field turns red after blur and on Save, and a fresh block shows no errors.
- An invalid block field holds autosave and shows a notice naming the block and field. Clicking the notice opens the block and focuses the field, and fixing the field resumes autosave.
- Save with an invalid field in a closed block opens that block and focuses the field.
- In right-to-left mode, values line up with their labels.
- Below 440 px of field width, settings rows stack.

### Lists inside blocks

Unit tests for choosing the presentation from sub-fields: one `string` or `url` sub-field, short tables with and without an image, a second image, and a `text` sub-field.

Browser tests for lists inside a block, using a test block type with a one-sub-field list for the type-in cases:

- In a type-in list, Enter adds a line after the current one, Backspace on an empty line removes it, and the arrow keys move between lines.
- Blank lines never reach the field's value, and leaving the list removes them.
- Table cells edit their sub-field, and an image cell opens the media picker.
- An open item's title edits its title sub-field and updates the closed summary.
- Move up, Move down, Duplicate and Delete with Undo keep item values and order.
- `maxItems` and `minItems` disable the right actions.
- Read-only lists ignore Enter and Backspace and offer no menus.

### Manual checks

On the marketing template's Home and Pricing pages, and on a block type with a one-sub-field list such as the mockup's Clients:

- desktop at 1280 and 1440 px, and phone width at 375 px;
- Arabic;
- dark mode;
- keyboard only: open a block's menu, move a block, add a block in place, edit a list and reach Undo;
- a screen reader, checking that quiet controls keep their labels and that hints and errors are announced through `aria-describedby`.

## Implementation

Three stacked implementation pull requests, one per part. Each is complete on its own, links this plan, and ships its own changeset:

1. **The block list:** `packages/admin/src/components/BlocksField.tsx`, its tests, and icons in the two marketing seeds.
2. **Fields inside a block:** `BlocksField.tsx` (layout rules, rows and validation), `ContentEditor.tsx` (quiet controls for nested fields and the autosave check), their tests, and the blocks guide section. Until the third pull request lands, lists keep today's repeater editor, full width in the content part.
3. **Lists inside blocks:** the block-field presentation of the repeater editor, connected in `BlocksField.tsx`, with its tests.

The second and third can land as one pull request if reviewers prefer. The last one sets this plan's status to `implemented` and records itself in the proposal index.

## Open questions

- Should blocks always start closed, or only on pages with more than a few blocks? Recommendation: always. It's predictable, and a one-block page costs one click.
- Is the menu footer the right home for the version number? Recommendation: yes. Content Types already lists every block type's versions.
- Should name-based layout stay the long-term approach, or should block fields get explicit `description` and `group` settings through an RFC? Recommendation: ship the name-based rules now. They need no schema change, and they would remain the fallback if settings arrive later.
- Should an empty required field turn red when you leave it, or only when you save? Recommendation: when you leave it, as in the mockup, but never on a block nobody has touched.
- Should pasting several lines into a type-in list add one item per line? Recommendation: yes. It makes moving a list in from a document a single paste.
- Should a list with a single image sub-field show a thumbnail grid instead of a one-column table? Recommendation: yes, in a follow-up plan.
