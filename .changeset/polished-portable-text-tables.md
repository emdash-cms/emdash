---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds responsive, lossless Portable Text tables with an accessible size picker, complete row and column controls, merge and split, persistent column widths, HTML and spreadsheet clipboard support, keyboard navigation, and right-to-left resizing. Wide tables keep their horizontal position while resizing, hide native scrollbar chrome, and show edge shadows for hidden columns.

Use the compact, scrollable Table menu for structural actions, or press Backspace or Delete to remove selected full rows or columns. Undo restores the removed content and structure.

The editor toolbar no longer includes Spotlight Mode, leaving more room for table controls at the standard editor width.

The public renderer now preserves table headers, spans, alignment, and preferred widths. Existing legacy string-cell tables continue to render. `portableTextToProsemirror()` now returns real `table`, `tableRow`, `tableHeader`, and `tableCell` nodes, so custom ProseMirror schemas that consume its output must register the existing TipTap table extensions.

Pass a localized `tablePlaceholder` string to `PortableText` to set the inline editor's initial table label. Omitted values retain the English label.
