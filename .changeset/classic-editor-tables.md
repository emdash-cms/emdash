---
"emdash": patch
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes WordPress imports turning tables in Classic editor posts into a single paragraph. Tables whose cells hold only text now import as tables, keeping their rows, header row, formatting and links. Tables with images, headings, lists or merged cells, with a caption or footer rows, or inside a `<div>` or `<figure>` keep their previous output.

`gutenbergToPortableText()` also sets `hasHeaderRow: true` on tables whose first row holds only `<th>` cells.
