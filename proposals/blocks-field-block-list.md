---
title: "Blocks field: scannable block list"
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-14
---

# Blocks field: scannable block list

This is the first of three plans for the admin's `blocks` field. It covers the list of blocks: how blocks look when closed, and how editors add, move and delete them. Two follow-up plans cover the fields inside an open block and the lists (repeaters) inside blocks.

## Problem and user case

Editors build landing pages from blocks. The marketing template's Home page has nine: Hero, Logo wall, Features, two Text and image blocks, Stats, Testimonials, FAQ and Call to action. Opening that page shows all nine as open forms, one after another.

The blocks field makes these pages slow to work with:

- Every block is a bordered card with its whole form open. Reaching the FAQ means scrolling past every field of the seven blocks above it.
- Every block header has a "Version 1" badge, plus Duplicate and Delete buttons that are always visible. Each of the Home page's nine blocks shows a red trash icon before anyone asks to delete anything.
- Putting an FAQ above the call to action means adding it at the bottom of the page, then dragging it up.
- The picker is a panel of text buttons, and it always adds to the end. Block types can already store an icon, but the admin never shows it.
- Deleting a block takes effect immediately and autosave keeps the loss. Getting it back means restoring an older revision.

## Proposed behavior

Try it in the [interactive mockup](https://emdash-blocks-field-mockup.gifted-paperback.workers.dev/?site=halden&notes=on). Notes 1 to 4 and 7 to 9 cover this plan. The mockup also covers the two follow-up plans.

### Closed blocks

- Blocks sit on one sheet, split by hairlines, instead of in separate cards.
- Existing blocks start closed when the edit screen opens. A closed block shows its icon, name and a one-line summary, plus a small thumbnail when the block has a photo.
- The summary is the block's first filled `string` or `text` field, preferring required fields. It skips link fields (a `url` field, or a `string` whose slug ends in `_url`, `_link` or `_href`), the section ID (`anchor_id`), and text that only repeats the block's name. A block without such text lists the titles of its first list's items instead. A Clients block whose heading is just "Clients" reads "Hotel Wilde, Het Bouwhuis, Ola Ceramics +3". An item's title is its first `string` sub-field that is neither a link field nor a button's text paired with a link field by name (such as `cta_label` with `cta_url`), or else its first `text` sub-field.
- "Collapse all" and "Expand all" sit next to the field's label.
- An open block's header stays pinned to the top of the screen while you scroll through that block, so you can always see which block you're in and close it.
- A block you add opens with its first field focused. A duplicated block appears below the original, open.

### Adding, moving and deleting

- Hovering a block shows a gutter outside the sheet, as in Notion. `+` adds a block below; Option-click or Alt-click adds one above. `⋮⋮` drags the block with a pointer. Clicking it, or pressing Enter or Space on it, opens the block's menu.
- Each block's `⋯` menu has Add block above, Add block below, Duplicate, Move up, Move down and Delete. The menu footer names the block type and its version, for example "Features · version 1".
- Keyboard users move blocks with Move up and Move down. They replace dragging with the keyboard, which the handle supports today.
- The picker opens next to where the block will go. It keeps today's search, category groups and descriptions, adds each block type's icon, and works with the arrow keys and Enter.
- "Add block" at the end of the sheet adds to the end.
- Deleting a block shows a toast with Undo, which puts the block back where it was. Retired, inactive-version and unsupported blocks ask for confirmation instead, because the server can't take them back once autosave has saved the deletion (see Errors and edge cases).
- Touch screens and phone-width screens have no room or hover for the gutter, so they hide it and show `⋯` on every row. Move up and Move down replace dragging there.

### Block states

- The "Version N" badge moves into the menu footer.
- "Inactive version", "Retired" and "Unsupported" stay on the row as quiet tags, because they change what the editor can do. The mockup doesn't show these states.

### Icons

- Rows and the picker show the block type's icon. A block type with no icon, or with a name that doesn't match a Phosphor icon, shows a generic block icon.
- The marketing template's 11 block types get icons, in both `templates/marketing` and `templates/marketing-cloudflare`.

## Goals

- An editor can see every block on a page, and what each one contains, without scrolling through forms.
- An editor can add a block anywhere, and move or delete one, without dragging.
- A block deleted by mistake can be put back on the spot.
- Everything works with a keyboard, a screen reader, right-to-left languages and phone screens.
- Existing sites get this without changing their schema or templates.

## Non-goals

- The layout of fields inside an open block, validation markers on closed blocks, and lists inside blocks. The two follow-up plans cover them.
- A live preview beside the form, or clicking a block on the site to open it.
- Copy and paste between pages, saved presets, hiding a block without deleting it, and remembering which blocks were open after a reload.
- Preview images in the picker. That needs a new stored field on block types.
- Blocks inside the rich text editor (Portable Text blocks).

## Interfaces and compatibility

- No changes to stored data, the API, the block type schema, or how sites render blocks. Moving a block keeps its `_key`, `_type` and `_version`.
- Undo adds the block back with the same `_key`, `_type`, `_version` and values. If autosave has already saved the deletion, the server treats the block as new, and it accepts new blocks only for allowed block types on their active version. That's why retired, inactive-version and unsupported blocks get a confirmation instead of Undo.
- `icon`, `description` and `category` already exist on block types. The admin resolves `icon` with the same Phosphor lookup it uses for collection and plugin icons (`resolveNavIcon`).
- Every site with a blocks field sees the new behavior: blocks start closed, Duplicate and Delete move into the menu, and the version badge moves into the menu footer. The implementation ships with an `@emdash-cms/admin` changeset that says so.
- Sites already created from the marketing template keep their stored block types, which have no icons, and show the generic icon. The seed change only affects new sites.
- New UI strings go through Lingui. Layout uses logical properties, so it mirrors in right-to-left languages.

## Errors and edge cases

- **Read-only:** no gutter, menu or Add block. Blocks still open and close.
- **At `maxItems`:** every add action and Duplicate are disabled, and a tooltip gives the limit. Today Duplicate stays enabled at the limit.
- **Below `minItems`:** the existing "Add at least N blocks." message stays.
- **Retired, inactive-version and unsupported blocks:** Duplicate stays disabled for retired and unsupported blocks, as today. Moving and adding next to any of them still work. Deleting one asks for confirmation and offers no Undo. An unsupported block opens to the existing "This block cannot be edited" message instead of fields.
- **First and last block:** Move up is disabled on the first block and Move down on the last.
- **Undo:** only the latest deletion can be undone, while its toast is showing. The toast is announced to screen readers and stays for 6 seconds. It pauses while the pointer is over it or focus is inside it, and it closes when you delete something else or leave the page. After that, restoring an older revision is the way back.
- **Site toolbar links:** `?field=content` still scrolls to the blocks field.
- **Long names and summaries:** the summary is cut off with an ellipsis. A block name too long for the row wraps, as it does today, so the row never overflows at 375 px.
- **Right-to-left languages:** the gutter sits on the right, menus open toward the end edge, and carets flip.

## Verification

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

Manual checks on the marketing template's Home page:

- desktop at 1280 and 1440 px, and phone width at 375 px;
- Arabic;
- dark mode;
- keyboard only: open the menu, move a block, add a block in place, and reach Undo;
- a screen reader.

## Implementation

One implementation pull request, changing `packages/admin/src/components/BlocksField.tsx`, its tests, and the two marketing seeds. The field layout and list plans build on it, one pull request each.

## Open questions

- Should blocks always start closed, or only on pages with more than a few blocks? Recommendation: always. It's predictable, and a one-block page costs one click.
- Is the menu footer the right home for the version number? Recommendation: yes. Content Types already lists every block type's versions.
