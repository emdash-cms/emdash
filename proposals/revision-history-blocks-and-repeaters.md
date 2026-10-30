---
title: Changes inside blocks and repeater fields in revision history
type: feature-plan
status: proposed
authors:
  - Leander Gilles (@LeanderG)
discussion: null
created: 2026-10-16
---

# Changes inside blocks and repeater fields in revision history

## Problem and user case

Sites built with blocks fields store most of a page in one field: a list of typed blocks such as Hero, Banner and Testimonials, each with its own fields. Editors review these pages in the Revisions panel like any other entry.

[Readable revision history](readable-revision-history.md) shows a blocks field as a single value. Changing one word in one block, reordering two blocks, or deleting a block all produce the same "Changed Content" entry. Selecting it scrolls to a box that reads "5 blocks". Repeater fields behave the same way, both at the top level and inside blocks. To find an edit, editors have to open the editor and compare the blocks by hand.

## Proposed behavior

Selecting a version shows each blocks or repeater field as cards, like the editor's block and repeater cards.

- Each block card shows the block type's label, its first line of text, and all of its fields. Fields are drawn the same way as top-level fields: added and removed words are marked in text and rich text, and changed images, toggles and other values are marked as they are today.
- Repeater items show as "Item 1", "Item 2", and so on, with their sub-fields drawn the same way. This applies to repeaters at the top level and inside blocks.
- Cards carry badges: Added, Removed, Edited and Moved. Added cards get the author-colored outline. Removed cards stay where they were, dimmed, with the label struck through. With Show changes off, removed cards are hidden and nothing is marked.
- The change list names each change to a block, and selecting an entry scrolls to it:
  - "Added the Hero block" and "Removed the Banner block" point at the card.
  - "Moved the Testimonials block" points at the card in its new position.
  - "Edited Headline in the Hero block" points at the Headline field inside that block. A block with several edited fields gets one entry per field.
- A change inside a top-level repeater keeps the existing "Changed <field label>" entry. The per-item marks appear in the view.

For example, a version that rewrites a Hero headline, adds a rotating statement to it, edits one word in a Banner's rich text body and deletes a second Banner lists:

- Edited Headline in the Hero block
- Edited Rotating statements in the Hero block
- Edited Body in the Banner block
- Removed the Banner block

## Goals

- Show which blocks and repeater items changed, and how.
- Show edits inside a block with the same marks as top-level fields.
- Let editors jump from the change list to the block or field that changed.
- Keep keyboard, screen reader, right-to-left and phone support from the readable revision history plan.

## Non-goals

- Comparing any two versions, or a version with the current draft.
- Restoring a single block or repeater item.
- Separate change list entries for each repeater item.
- Collapsing block cards in the version view. All cards show their fields.

## Interfaces and compatibility

None. The change is limited to the admin:

- No API, database, or revision format changes. The admin computes the diff from revision data the list already returns.
- Block labels and field definitions come from the block types the collection schema already sends to the editor. The diff reads the definition of each block's stored `_version`.
- Fields that the readable revision history plan doesn't cover keep the "Changed <field label>" fallback.

## Errors and edge cases

- Blocks are paired between versions by `_key`. Blocks without a key, or whose key appears more than once, are paired by identical content, then by position between blocks that kept their place. Two blocks with different keys are never paired.
- Repeater items have no stored keys. They are paired by identical content first, then by position among the items that changed, so editing one item reads as an edit rather than a removal and an addition. Removing an item and editing its neighbor in the same save can read as an edit to one item and the removal of another.
- When a reorder can be described in more than one way, one block is marked as moved. It may not be the block the editor dragged: moving A above B can read as "Moved B".
- Move detection is bounded like block pairing in rich text. Past that bound, blocks are still compared but no block is marked as moved.
- A block type version upgrade that leaves every value equal is not reported as a change. A field that only the old version defines, or a stored value that no version defines, appears only when its value changed, as raw JSON.
- A block whose type is no longer defined shows its type slug as its label and lists only the stored values that changed.
- A field inside a block that has no inline marks, such as a file, falls back to the same display it has at the top level.
- The first version still reads "First version" with nothing marked.

## Verification

- Unit tests for the diff:
  - blocks added, removed, swapped, and moved and edited at once;
  - a version upgrade with no value changes;
  - blocks without keys;
  - removed blocks placed after their predecessor;
  - word-level diffs inside a block's text field;
  - repeater items paired by content and by position;
  - a repeater inside a block.
- Unit tests for the change list labels and their targets, including targets for fields inside blocks.
- Component tests:
  - cards marked added, removed, edited and moved;
  - edits marked inside a block's field, and that field as the jump target;
  - repeater item numbering;
  - the clean view with Show changes off.
- A manual pass with blocks containing text, rich text and a repeater, in English and in Arabic.

## Open questions

- Should top-level repeaters list one change list entry per item instead of "Changed <field label>"?
- Should edited block cards also get the author-colored outline, or are the marks inside the fields enough?
- When a reorder is ambiguous, should a block that was also edited be preferred as the one that moved?
