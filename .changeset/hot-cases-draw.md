---
"emdash": patch
---

Fixes seed imports assigning taxonomy terms from another locale when slugs are shared across translations. Taxonomy references now resolve in the content entry's locale. When no term with that slug exists in the entry's locale, the import logs a warning and skips that assignment instead of attaching a term from another locale; add the term in that locale to keep the assignment.

Reapplying a seed in update mode also preserves taxonomy assignments contributed by each content translation instead of letting later translations erase earlier ones.

Existing assignments are not repaired automatically. To repair seeded entries already attached to a wrong-locale term, reapply the seed with `--on-conflict update`. This also overwrites other seeded records with the seed's values, so review the seed before reapplying it.
