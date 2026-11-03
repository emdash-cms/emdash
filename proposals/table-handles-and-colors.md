---
title: Table handles and cell colors
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-16
---

# Table handles and cell colors

## Problem and user case

Editors use tables for pricing plans, comparisons, schedules, and status reports. Two things get in their way.

First, the table controls are a floating toolbar that appears every time someone clicks a cell. It covers the row below, and its ⋯ menu holds 20 commands in one list: selecting, adding, and deleting rows and columns, headers, merging, column widths, and inserting paragraphs. Finding "Delete column" means reading past everything else. Rows and columns can't be reordered at all.

Second, tables have no colors. In Notion and Google Docs, editors shade a header row, highlight a recommended plan, or mark rows by status. When they paste one of those tables into EmDash, the shading is lost, and there's no way to add it back.

## Proposed behavior

You can try everything below in the [interactive mockup](https://emdash-table-handles-mockup.emdash-cms.workers.dev/). It uses sample content and doesn't save anything.

### Handles instead of a toolbar

Clicking a cell gives it a blue outline and shows small handles on the table's edges. Nothing covers the content.

- A gray pill sits on the top edge above the column under the pointer, and another on the start edge beside the row. The pills follow the pointer and hide when it leaves the table. The outline stays.
- A blue pill sits on the end edge of the selected cell, or of a selected group of cells. Clicking it opens the cell menu.
- Hovering a pill grows it into a button with a drag grip. Clicking a row or column pill selects that row or column and opens its menu. Dragging the pill moves the row or column, and a blue line shows where it will land.
- Near the table's bottom or end edge, a **+** bar appears. Clicking it adds a row or column and puts the cursor in it. Dragging it adds several at once and shows the count next to the pointer. A **+** at the corner adds a row and a column.
- Dragging the border between columns resizes them, as it does today.

Each menu lists only the commands for what was clicked:

| Handle                  | Menu                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Row                     | Color, Add row above, Add row below, Duplicate row, Clear contents, Delete row. The first row also has a Header row switch.                    |
| Column                  | Color, Add column before, Add column after, Duplicate column, Clear contents, Delete column. The first column also has a Header column switch. |
| Cell                    | Color, Clear contents. With several cells selected, Merge cells. On a merged cell, Split cell.                                                 |
| Table (⋮⋮ block handle) | Header row, Header column, Distribute columns evenly, Reset column widths, Duplicate table, Move up, Move down, Delete table.                  |

A header row stays first. Its pill can't be dragged, no other row can be dropped above it, and Add row above is unavailable on it. A header column works the same way.

### Cell colors

**Color** opens a list: No color, then Gray, Brown, Orange, Yellow, Green, Blue, Purple, Pink, and Red, each with a swatch. The current color is checked. When the cells have different colors, nothing is checked. Hovering a color previews it on the cells, and clicking applies it.

After coloring a row, a column, or a group of cells, the outline stays so the editor can try another color. The blue selection tint is removed so the real color shows.

Colors are translucent tints, with a separate set for dark mode. Each color has its own lightness, so neighbors such as orange and yellow stay easy to tell apart. They layer over header shading, the selection highlight, and the site's own row striping. Text on every color keeps at least 7:1 contrast in the admin's light and dark modes.

### Keyboard, touch, and right-to-left

- Alt+F10 in a table focuses the **Table** button in the editor toolbar, as it does today. Its menu has Row, Column, Cell, and Table submenus with the same commands as the handles. It also has Select row, Select column, Select table, Make column wider, Make column narrower, Insert paragraph before, and Insert paragraph after, which have no handle equivalent.
- In a cell, Esc selects the cell, and a second Esc selects the table. Enter returns to editing the selected cell.
- Screen readers announce each change, for example "Row added" or "Cell color changed to Blue". Undo reverts one change at a time, including a drag that adds several rows.
- On touch screens, the handles for the selected cell stay visible, tap targets are at least 44px, and the **+** bars show while the table is selected.
- Handles and menus mirror in right-to-left languages.

## Goals

- Keep table content visible while editing: no floating toolbar over the table.
- Put every table command one click from the row, column, cell, or table it affects.
- Reorder rows and columns by dragging.
- Color one cell, a selection, a row, a column, or a whole table in two clicks.
- Show colors the same way in the editor, in revision history, and on the published site, in light and dark appearances.
- Work with a keyboard, screen readers, right-to-left languages, and touch screens.

## Non-goals

- Text color, cell borders, and border colors.
- Custom colors, a color picker, or hex values.
- Importing colors from pasted Google Docs, Word, or WordPress tables.
- Moving several rows or columns in one drag.
- Sorting, filtering, or typed columns.
- Changing how tables render on the site, apart from colors.

## Interfaces and compatibility

**Handles** don't change stored content. Moving, duplicating, and clearing rows and columns produce ordinary Portable Text tables. The floating table toolbar and its ⋯ menu are removed. Their commands move into the handle menus and the toolbar's **Table** menu.

**Cell colors** add one optional field to table cells:

```json
{
	"_type": "tableCell",
	"_key": "c1",
	"backgroundColor": "blue",
	"content": [{ "_type": "span", "_key": "s1", "text": "Team" }]
}
```

`backgroundColor` is one of `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, or `red`. Leaving it out means no color. Named colors, rather than hex values, let EmDash pick tints that read well in light and dark themes. They also keep cell markup free of inline styles and stop editors from choosing combinations that hide text.

Content API and MCP clients read and write the field like any other cell field. [Generated HTML](#generated-html) describes how sites render it.

The change is additive. Existing tables have no colors and render as before. An older admin keeps the colors when it saves a table, because it passes unknown cell fields through unchanged, but it doesn't show them. A cell `backgroundColor` outside the nine names, which no EmDash importer writes, is removed the next time the admin saves the table.

### Generated HTML

EmDash's table component writes the color name to a `data-background-color` attribute on the `th` or `td`. It adds no inline styles or classes, and a cell without a color has no attribute. For a table with a blue header row and one green cell, the site receives this markup (simplified, without Astro's scoping attributes):

```html
<div class="emdash-table-wrapper">
	<table class="emdash-table">
		<thead>
			<tr>
				<th scope="col" data-background-color="blue"><p>Plan</p></th>
				<th scope="col" data-background-color="blue"><p>Price</p></th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td data-background-color="green"><p>Team</p></td>
				<td><p>$29 / month</p></td>
			</tr>
		</tbody>
	</table>
</div>
```

The component's stylesheet maps each name to a translucent tint and paints it as a background image, so header shading, row striping, and hover backgrounds still show underneath:

```css
.emdash-table [data-background-color] {
	background-image: linear-gradient(var(--emdash-table-cell-color), var(--emdash-table-cell-color));
}

.emdash-table [data-background-color="blue"] {
	--emdash-table-cell-color: var(
		--emdash-table-color-blue,
		light-dark(oklch(0.727 0.124 239 / 0.28), oklch(0.447 0.123 249 / 0.4))
	);
}
```

`light-dark()` picks the dark tint when the site declares `color-scheme: dark`, as EmDash's templates do. A dark theme that doesn't declare it gets the light tints, which stay readable.

A theme sets its own shade for a color with a `--emdash-table-color-<name>` custom property, without needing to match the component's selectors:

```css
:root {
	--emdash-table-color-blue: oklch(0.7 0.12 250 / 0.3);
}
```

The nine attribute values and the nine `--emdash-table-color-*` properties become part of the table component's public styling interface. The admin editor and revision history use the same attribute and the default palette.

## Errors and edge cases

- A row or column can't be moved across a merged cell. The drop line doesn't appear there, and the row or column stays where it was.
- Delete row and Delete column are unavailable when only one row or column is left.
- In a table wider than the editor, row pills stay on the visible start edge while the table scrolls sideways.
- New rows and columns start without a color. Duplicated rows and columns keep their content and colors. Clear contents removes text but keeps colors.
- Merging cells keeps the color of the first cell. Splitting a merged cell gives its color to every resulting cell.
- Pasting tab-separated text into colored cells replaces their text but keeps their colors. Copying cells between EmDash tables keeps their colors. Colors in other applications' clipboard HTML are ignored.
- Values outside the nine color names are dropped when a table is normalized, so they never reach the editor, the revision view, or the site.
- In forced-colors mode, the tints and swatches disappear along with other author colors, and the menu still names each color.

## Verification

- Table commands: moving rows and columns, the pinned header row and column, refusal across merged cells, duplicating with content and colors, and Clear contents keeping colors.
- Browser tests:
  - Handles appear for the hovered row and column and for the selected cell, and hide when the pointer leaves.
  - Clicking a pill selects its row or column and opens the matching menu.
  - Dragging a pill reorders.
  - Clicking or dragging a **+** bar adds rows or columns, with one undo step per drag.
  - The **Table** menu reaches every command from the keyboard.
- Portable Text normalization keeps palette colors through a ProseMirror round trip and drops other values.
- Coloring the cursor cell, a selection, and a whole table keeps the selection and records one undo step per change. The color menu reports no color, one color, or a mixed selection.
- Merge, split, and tab-separated paste keep colors as described above, and clipboard HTML ignores values outside the palette.
- The site table component renders palette colors as `data-background-color` and drops other values. A theme's `--emdash-table-color-*` value replaces the default tint. In both admin modes, text on every color keeps at least 7:1 contrast, and every two colors stay perceptibly different.
- Manual checks in light and dark mode, in Arabic, at a phone width, and with a screen reader.

## Open questions

- Should the selected cell's handles stay visible after the pointer leaves the table? The mockup hides them, as Notion does. Keyboard users reach the same commands through the **Table** menu.
- Should handles and colors ship as two implementation pull requests, handles first, or as one?
