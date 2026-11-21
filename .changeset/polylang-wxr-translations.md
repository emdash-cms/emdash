---
"emdash": patch
---

Fixes WordPress imports from sites translated with Polylang. Posts in a standard WordPress export are linked to their translations, and translated categories, tags, and other terms arrive in their own language, under their own names, linked to their translations. Previously each post arrived unlinked, and every term was created in the default locale and copied into the others under its slug, so posts outside the default locale showed slugs such as `past` instead of category names, and each locale listed the terms of every other. Polylang's internal taxonomies are no longer reported as missing. A term translation that already exists on the site is linked to the imported ones; when a term's existing translations sit in different translation groups, the import stops with a conflict that names them, so they can be linked in the admin first.
