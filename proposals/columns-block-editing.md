---
title: Make the columns block editable
type: feature-plan
status: proposed
authors:
  - Zach Bimson (@bimsonz)
discussion: https://github.com/emdash-cms/emdash/discussions/2049
created: 2026-10-11
---

# Make the columns block editable

## Problem and user case

Authors can't lay content out side by side in a Portable Text field. Discussion #2049, Louis Escher's RFC for a nesting block, asks for a container that holds ordinary blocks in columns. ascorbic replied that it was worth approving for a PR after experiments with the editor, and the blocks field RFC on #337 keeps #2049 as a prose-side container.

Core already has half of this. The WordPress importer writes a `columns` block for `core/columns` and `core/media-text`, and `Columns.astro` renders it. But the editor can't edit it. It opens as an uneditable card, the slash menu has no way to make one, and on the site the blocks inside a column render without the page's components. On a fresh 1.2.0 site, an image in an imported column renders as a hidden "missing image" placeholder.

I run a site, boulderbrighton.dev, whose header, footer and page layouts have been built from a patched version of the #2049 prototype since August. This plan is what that taught us, moved onto the block core already has.

## Proposed behavior

In the editor:

- `/columns` (Basic blocks; also found by "layout", "sidebar" and "side by side") inserts two columns and opens the first.
- A columns block shows as a map of its layout: one box per column, at the column's relative width, naming its first heading (or its first line of text) and the kinds of block it holds. Column content isn't edited side by side. With three or more columns on a laptop each column is too narrow to read or write in, and a page built from a few rows runs to several screens.
- Clicking a box opens that column below the map, at the full width of the editor. One column is open at a time. Done, clicking the box again, or moving the selection out of the block closes it, and a selection that lands in a closed column (undo, search, the keyboard) opens it.
- A column holds ordinary blocks, another columns block included, which shows as its own map inside the open column. A columns block can't go inside a list or a quote.
- Each block in an open column gets its own drag handle, `+` and block menu. Escape selects it, the arrow keys and Move up/down stay inside the column, and turn into, Duplicate and the slash menu work on it. A list moves as one block.
- Each row has a button to add a column and settings for the gap, vertical alignment and wrapping.
- An open column's menu adds a column before or after it, moves it earlier or later, sets its width (Normal, Wide, Wider) and deletes it. The UI adds up to 6 columns; an imported block with more still loads.
- Which column is open is view state. It isn't stored or in the undo history, and opening a column never changes the document.

On the site:

- `Columns` renders each column through `PortableText` with the components the page passed, so site and plugin blocks work inside a column.
- Gap, alignment, wrap and width are classes. Columns stack below 768px as today, unless they wrap.

Search text extraction and media usage tracking also look inside columns.

A sidebar layout with a wide first column, as stored:

```json
{
	"_type": "columns",
	"_key": "a1",
	"gap": "lg",
	"verticalAlignment": "top",
	"columns": [
		{ "_type": "column", "_key": "c1", "span": 2, "content": [] },
		{ "_type": "column", "_key": "c2", "content": [] }
	]
}
```

## Goals

- Imported WordPress columns open editable and render their content with the site's components.
- Authors can see a page's layout at a glance and edit any column at the editor's full width.
- Authors can create, nest, rearrange, resize and delete columns without leaving the editor.
- Opening content with columns and closing it unchanged saves nothing.
- Columns work with the keyboard, in right-to-left locales and in translation like the rest of the editor.

## Non-goals

- A new block type. The #2049 prototype added a `nestingBlock` that stored a container's blocks under `children`, which Portable Text uses for a text block's spans, so the toolkit read the container as a paragraph. Core's `columns` stores them under `content` and is already written by the importer.
- Editing `cover`.
- Markdown for column content. The MCP tools and CLI keep the block as a JSON fence, which round-trips.
- Dragging columns to reorder them. The column menu moves them.
- The importer carrying WordPress's alignment and widths. The field names line up, so it can follow.
- A general layout or blocks field (#337).
- Showing changes inside a column in revision history. It shows a columns block as one block, as it does a table.

## Interfaces and compatibility

Stored data gets optional fields only. Absent fields render exactly as today.

```
{ _type: "columns", _key,
  gap?: "none" | "sm" | "md" | "lg",                  // absent or "md": today's 2rem
  verticalAlignment?: "top" | "center" | "bottom",    // WordPress's name; absent: stretch, as today
  wrap?: true,                                        // wrap at a minimum width instead of stacking
  columns: [{ _type: "column", _key,
              span?: 2 | 3,                           // relative width; absent: 1
              width?: string,                         // existing, undocumented; still honoured
              content: Block[] }] }
```

- Values are kept as stored and only interpreted when rendering, so an unknown value survives a save and an imported block saves unchanged unless it's edited.
- The existing `width` is now checked to be a CSS length before it reaches a `style` attribute. Today any stored string is written there.
- `PortableTextColumnsBlock`, the importer's existing type, joins core's `PortableTextBlock` union and public types.
- The admin and core converter pairs share one columns module, exported from `@emdash-cms/admin` as the table's is.
- `PortableText` passes its props to a block that renders Portable Text of its own through a non-enumerable property on the blocks, since astro-portabletext gives a type component only its node. `Columns` is the only user in this plan; `Cover` and `Table` have the same gap and could adopt it later.
- Overriding `columns` through `components.types` works as before. A plugin that registers a `columns` block type keeps it, and the editor leaves the block to the plugin.
- Media usage indexes from before are reported stale and re-extracted, as #3096 did for galleries.
- The editor's row commands generalise #3710's top-level logic in `BlockCommands`, `blockTypes` and the insert paths. At the top level the ranges are the same.

## Errors and edge cases

- A malformed block (no `columns` array, or a child that isn't a `column`) stays an uneditable card and is saved unchanged.
- An empty column is one empty paragraph in the editor and `content: []` when stored. Emptying a column keeps it, and the last column can't be deleted.
- Keys are de-duplicated per sibling array, as Portable Text requires, so valid keys in different columns are never rewritten.
- A selection across two columns resolves to the whole columns block, and turn into is off for it.
- Ordered list numbering is scoped to each column.
- Unsupported marks inside a column make the editor read-only, as they do at the top level. Today the uneditable card hides them, so a document like that becomes read-only where it wasn't. I expect this to be rare.
- TipTap's nested drag targeting picks the wrong block over the lower half of an atom such as an image or embed, because it reads the node after `posAtCoords().pos`. This turns nested targeting on, so it shows at the top level too. It's a TipTap bug, still in 3.32.0; the fix belongs in TipTap.
- Imported content that ends in a columns block relies on #4035 to open without saving a draft. #4035 is merged.

## Verification

Tests, each shown to fail without its change:

- Conversion round trips in both converter pairs: the WordPress shape, the legacy `width`, an empty column, unknown values, duplicate keys across columns, and a plugin block, table, embed, HTML block and nested columns inside a column. Malformed blocks and plugin-owned `columns` fall back.
- Opening content that ends in columns reports no change.
- Rows: Escape, the arrow keys, Move, turn into and the insert paths inside a column; the drag-handle rule.
- The node views: the map's summaries, opening and closing a column (including when the selection moves into a closed one), the column menu, settings, and no change reported on mount or when a column opens.
- Text extraction and media usage inside columns.
- Rendering: the page's components reach blocks in a column, the classes, the width check, and absent fields rendering as today.

In a browser, on a fresh 1.2.0 Cloudflare site, before and after: imported columns open editable and render their image; a page built from rows of two, three, four and six columns; building, nesting, moving, resizing and deleting columns; an embed and a table in a column; gap, alignment and wrap; dragging blocks between columns; the keyboard; Arabic; publishing and viewing at desktop and phone widths; and reopening without a draft.

The implementation is written and will follow as its own PR.

## Open questions

- Feature plan or RFC. This adds optional fields to a stored block and touches core and the admin. I've written it as a feature plan because it's additive and fits the existing architecture, as #1967 did for galleries. If you'd rather have an RFC, I'll convert it.
