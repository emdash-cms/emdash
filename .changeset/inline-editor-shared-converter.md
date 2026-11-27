---
"emdash": patch
---

The visual editor now reads and saves rich text with the admin editor's schema and converter, so a Portable Text field saves the same way from either editor. When you edit on the page, spans and link definitions keep their `_key`s (as blocks already did), and a table you cut and paste keeps its rows and cells. Tables, galleries, embeds, videos and plugin blocks still show as placeholders to edit in the admin, and they save unchanged. If a field contains a table the admin editor can't open, the visual editor says so instead of loading the field.
