---
"@emdash-cms/admin": minor
---

Updates `blocks` fields in the content editor so editors can scan a page of blocks, add, move or delete one without scrolling through every form, and edit an open block in the order the page shows it. Lists inside blocks take a shape that fits what they hold, and the admin checks block fields before saving. Every site with a blocks field gets the new editor; stored content, the API, block type schemas and how sites render blocks are unchanged.

#### The block list

- Blocks sit on one sheet and start closed when the edit screen opens. In a read-only entry, every block and list item shows open, since its controls can't be used there. A closed block shows its type's icon, its name, a one-line summary of its text or of its first list's items, and a thumbnail when it has a photo. "Collapse all" and "Expand all" sit next to the field's label, and an open block's header stays pinned while you scroll through its fields.
- Each block's `⋯` menu has Add block above, Add block below, Duplicate, Move up, Move down and Delete. Its footer names the block type and version, such as "Hero · version 2", which replaces the "Version N" badge on every block. "Inactive version", "Retired" and "Unsupported" stay on the block as tags.
- On screens at least 40rem wide with a mouse or trackpad, hovering a block shows `+`, which adds a block below (Alt-click adds one above), and a handle that drags the block or opens its menu. On touch and phone-width screens, `⋯` is always visible. The handle no longer reorders blocks from the keyboard; use Move up and Move down instead.
- The block picker opens next to where the block will go, keeps its search, categories and descriptions, shows each block type's icon, and works with the arrow keys and Enter. A block you add opens with its first field focused, and a duplicate opens below the original.
- Deleting a block shows a toast with Undo for 6 seconds, which puts the block back in its place. Blocks of a retired type, an older version or an unavailable definition ask for confirmation instead and can't be undone, because the server doesn't accept them as new blocks once the deletion is saved.
- At the field's `maxItems`, every add action and Duplicate are disabled, and the add buttons explain the limit. Duplicate is also disabled for blocks on an older version of their type, because the server only accepts new blocks on the active version.

#### Fields inside a block

- An open block shows its content first: one-line text, text areas, rich text, photos and lists, each under a small label. The block's headline is drawn larger, two or three one-line text fields in a row share a line, a photo's `{image}_caption` field sits under it, and text areas start one line tall and grow as you type.
- Settings follow as rows under a divider, with the label beside the value: switches, choices, numbers, dates, files and links. A button's text and its link share one row, such as `cta_label` and `cta_url`. The section ID (`anchor_id`) waits in a closed Advanced row that shows its value. When the field is narrower than 440 px, each row puts its label above its value.
- Fields have no box until you hover or focus them. A label that ends in parentheses with a space, or in ", for example …", becomes a short label and a hint: "Link (starts with / or https://)" reads "Link", with the hint in the empty field, under the field while you type, and as the error when the value doesn't match the field's `pattern`. "Price (USD)" stays whole.

#### Lists inside a block

- A list (`repeater` field) inside a block takes its shape from its sub-fields. A list with one `string` or `url` sub-field is a bulleted type-in list: Enter adds a line after the current one, Backspace on an empty line removes it, the arrow keys move between lines, and pasting several lines adds one item per line. Blank lines you add are never saved, and leaving the list removes them. A list with up to three `string`, `url`, `number`, `integer`, `select` or `image` sub-fields, at most one of them an image, is a table with a column per sub-field, and its image cells open the media picker. Every other list shows expandable items: a closed item shows its title, up to two more of its values and a thumbnail, and an open item edits its title in its row, with its other sub-fields laid out like a block's.
- A list with items shows its count next to its label. Hovering an item shows a drag handle and a `⋯` menu with Move up, Move down and Delete; expandable items also have Duplicate. On touch and phone-width screens, `⋯` is always visible. Deleting an item shows a toast with Undo, shared with block deletions, so only the latest deletion of a block or an item can be undone. "Add item" sits at the end of the list and is hidden at the list's `maxItems`, and Delete is disabled at its `minItems`.
- A new list item leaves its sub-fields unset, so an empty link, choice or date sub-field no longer stops the entry from saving, and clearing a link writes `null`.

The layout of fields and lists follows field types and names. The naming conventions, and how a list's sub-fields pick its shape and its items' titles, are listed in [Build pages with blocks](https://docs.emdashcms.com/guides/blocks/#name-fields-for-the-editor-layout); a field that matches none of them gets a row of its own. Top-level `repeater` fields keep their current editor.

#### Checks and autosave

- The admin checks block fields with the server's rules: required fields, patterns, lengths, number ranges, whole numbers, choices, safe links, list sizes and required list sub-fields. An empty required field reads "Required"; after you leave it, or when you save or publish, it turns red. A problem in a list item marks its control, and a closed block or list item with a problem shows a red dot. A newly added block shows nothing until you leave one of its fields or save. Save and Publish open the first block with a problem, and the list item that holds it, and focus the field.
- While a block field has a problem, autosave waits, as it does for an invalid URL, and an "Autosave paused" notice names the block and field. Its Show button opens the block and focuses the field. Autosave resumes with your next change once every problem is fixed. A new block's switches start off, so a required switch is never missing.

#### Block type icons

Block types show their `icon` setting, a Phosphor icon name such as `"sparkle"` or `"chart-bar"`, in the block list and the picker. A block type without an icon, or with a name that doesn't match a Phosphor icon, shows a generic block icon. The marketing and portfolio templates now give their block types icons. Sites created from those templates before this release keep their stored block types, which have no icons, so their blocks show the generic icon until each block type gets an `icon`, for example through `PUT /_emdash/api/schema/block-types/{slug}` or the `schema_update_block_type` MCP tool.
