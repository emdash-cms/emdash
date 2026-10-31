---
"@emdash-cms/admin": minor
---

Updates the block list of `blocks` fields in the content editor so editors can scan a page of blocks and add, move or delete one without scrolling through every form. Every site with a blocks field gets the new list; stored content, the API and how sites render blocks are unchanged.

- Blocks sit on one sheet and start closed when the edit screen opens. A closed block shows its type's icon, its name, a one-line summary of its text or of its first list's items, and a thumbnail when it has a photo. "Collapse all" and "Expand all" sit next to the field's label, and an open block's header stays pinned while you scroll through its fields.
- Each block's `⋯` menu has Add block above, Add block below, Duplicate, Move up, Move down and Delete. Its footer names the block type and version, such as "Hero · version 2", which replaces the "Version N" badge on every block. "Inactive version", "Retired" and "Unsupported" stay on the block as tags.
- On screens at least 40rem wide with a mouse or trackpad, hovering a block shows `+`, which adds a block below (Alt-click adds one above), and a handle that drags the block or opens its menu. On touch and phone-width screens, `⋯` is always visible. The handle no longer reorders blocks from the keyboard; use Move up and Move down instead.
- The block picker opens next to where the block will go, keeps its search, categories and descriptions, shows each block type's icon, and works with the arrow keys and Enter. A block you add opens with its first field focused, and a duplicate opens below the original.
- Deleting a block shows a toast with Undo for 6 seconds, which puts the block back in its place. Blocks of a retired type, an older version or an unavailable definition ask for confirmation instead and can't be undone, because the server doesn't accept them as new blocks once the deletion is saved.
- At the field's `maxItems`, every add action and Duplicate are disabled, and the add buttons explain the limit. Duplicate is also disabled for blocks on an older version of their type, because the server only accepts new blocks on the active version.

Block types show their `icon` setting, a Phosphor icon name such as `"sparkle"` or `"chart-bar"`, in the block list and the picker. A block type without an icon, or with a name that doesn't match a Phosphor icon, shows a generic block icon. The marketing and portfolio templates now give their block types icons. Sites created from those templates before this release keep their stored block types, which have no icons, so their blocks show the generic icon until each block type gets an `icon`, for example through `PUT /_emdash/api/schema/block-types/{slug}` or the `schema_update_block_type` MCP tool.
