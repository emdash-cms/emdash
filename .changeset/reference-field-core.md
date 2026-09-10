---
"emdash": minor
---

Adds reference fields that store relationships between entries. Selections are written atomically with the entry and are hydrated on read alongside SEO and bylines. Each resolved reference includes a display title from the referenced entry's configured title field, `title`, or `name`, so pickers and backlinks show a readable label.

Reference fields enforce required and single-selection constraints for entry saves and direct reference requests. Reference selections are shared across translations, so creating a translation reuses the source entry's selection.

Reference fields are storage-less: new fields do not add a column to the collection table. Seed files continue to use `$ref:` values. Existing reference columns remain in place for compatibility, but EmDash no longer writes to them.

Storage-less reference fields can no longer be marked as indexed, and large reference replacements are split into D1-safe writes while preserving selection order.

Relations are now first-class schema objects rather than a hidden detail of each reference field. A relation joins two collections under a slug that is unique across the site, and a reference field records which end of that relation it sits on — so the same relation can back a field on either side. A relation carries a label and an optional singular form for each role, plus an optional limit on how many entries each side may hold.

Migration 076 restructures `_emdash_relations` to match: the per-locale rows collapse into one row per relation, keyed by a new unique `slug`, and `_emdash_content_references.relation_group` becomes `relation_id`. Relation ids are preserved, so existing reference edges stay valid. Relations are no longer localized — like collections and fields, their labels are single-valued. Where per-locale rows existed, the lowest locale code's labels win.

Deleting a reference field no longer deletes its relation by default. The relation and its edges survive until they are deleted deliberately, either from the relations admin or by opting in on the field delete, which also removes the field bound to the relation's other side. Deleting a collection removes every relation it is an end of, along with the reference fields viewing them — including fields on the collection at the far end, which would otherwise address a collection that no longer exists.

Reading a relation now reports what deleting it would take: the reference fields bound to it and how many links it holds.
