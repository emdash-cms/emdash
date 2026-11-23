---
"emdash": patch
---

Fixes WordPress imports from sites translated with Polylang. Posts in a WordPress export of **All content** are linked to their translations, and translated categories, tags, and other terms arrive in their own language, under their own names, linked to their translations. Previously each post arrived unlinked, and every term was created in the default locale and copied into the others under its slug, so posts outside the default locale showed slugs such as `past` instead of category names, and each locale listed the terms of every other. An export of **Posts** leaves out the translations of categories and tags, so its posts still arrive unlinked. Polylang's internal taxonomies are no longer reported as missing.

Imported terms join their translations that already exist on the site. When a term's existing translations sit in different translation groups, the import stops with a conflict that names them, because existing terms can't be linked. This happens when you import a Polylang site again after importing it with an earlier version: delete the entries and terms the earlier import created, then import again.
