---
"emdash": minor
---

Adds reference fields that store relationships between entries. Selections are written atomically with the entry and are hydrated on read alongside SEO and bylines. Each resolved reference includes a display title from the referenced entry's configured title field, `title`, or `name`, so pickers and backlinks show a readable label.

Reference fields enforce required and single-selection constraints for entry saves and direct reference requests. Reference selections are shared across translations, so creating a translation reuses the source entry's selection.

Reference fields are storage-less: new fields do not add a column to the collection table. Seed files continue to use `$ref:` values. Existing reference columns remain in place for compatibility, but EmDash no longer writes to them.

Storage-less reference fields can no longer be marked as indexed, and large reference replacements are split into D1-safe writes while preserving selection order.
