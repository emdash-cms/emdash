---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes captions being omitted from image field values and their generated TypeScript types. Image selection, content saves, and seed export/import preserve captions, including explicitly empty captions. Seed exports keep library defaults separately from per-use captions. Image and focal-point edits retain per-use captions unless the caption is explicitly edited. Templates should read the top-level `caption`; the legacy `meta.caption` alias stays consistent when present.

For existing image fields whose captions were previously omitted, reselect the image or explicitly edit its caption, then save and publish the content entry. Upgrading alone does not fill captions into previously stored content values.
