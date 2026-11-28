---
"emdash": patch
"@emdash-cms/admin": patch
---

The visual editor now reads and saves rich text with the admin editor's schema and converter, so a Portable Text field saves the same way from either editor. When you edit on the page, spans and link definitions keep their `_key`s (as blocks already did). Tables, galleries, embeds, videos and plugin blocks still show as placeholders to edit in the admin, and they save unchanged. If a field contains a table the admin editor can't open, the visual editor says so instead of loading the field.

Both editors now keep the `_key`, dimensions, display size, alignment and link of an image block stored with only a `url` and no `asset`, such as imported content. Before, the admin editor dropped them on save.
