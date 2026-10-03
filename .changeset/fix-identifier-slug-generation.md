---
"@emdash-cms/admin": patch
---

Fix generated identifier slugs for non-ASCII labels.

Labels like `Größe` now produce `groesse`, `Título` becomes `titulo`, and labels written entirely in scripts without ASCII letters (e.g. `名前`, `2024年`) leave the slug empty with an inline message instead of creating an invalid slug. The logic is now shared across the content type, taxonomy, byline-field, relation, and field editors, and repeater sub-fields expose their own slug input.
