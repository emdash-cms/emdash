---
"@emdash-cms/admin": patch
---

Fixes generated admin identifier slugs for non-ASCII labels in content types, taxonomies, byline fields, relations, and fields.

Labels like `Größe` now produce `groesse` and `Título` becomes `titulo`, including equivalent decomposed Unicode input. Labels that cannot produce a valid ASCII identifier, such as `名前` or `2024年`, require a manually entered slug and show an inline message.

Adds editable slugs for new repeater sub-fields and blocks duplicate sub-field slugs before saving. Existing sub-field slugs stay read-only so relabeling preserves the keys used by saved content.
