---
"@emdash-cms/admin": patch
---

Fixes rich text block keys changing on every save. Blocks added in the editor now keep the same `_key` from save to save, so saving the same content twice gives identical Portable Text. Saving also stops changing a few stored shapes: list items that start at a nested level keep their level, line breaks inside table cells keep their spans, and a span marked both subscript and superscript keeps subscript.

Also adds the `@emdash-cms/admin/portable-text` export, which gives server code the editor's schema and Portable Text converter.
