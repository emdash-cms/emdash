---
"emdash": patch
---

Fixes seed menu items losing their `translation_group` across export/apply by adding optional `id`, `locale`, and `translationOf` fields to `SeedMenuItem`. The export emits stable seed IDs and `translationOf` references; the apply resolves them to the anchor's `translation_group`, matching the existing pattern for content entries, taxonomies, and terms.
