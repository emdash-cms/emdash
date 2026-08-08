---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds cross-collection duplication. Duplicate now always opens a dialog — from a content row, from a selection of up to 50 entries, or from the editor's sidebar — where you pick which collection the copy lands in. Choosing a different collection reveals a field mapping, which only pairs fields with matching column types, is validated before anything is written, and can be remembered per collection pair. The dialog names everything the copy will drop: unmapped fields, taxonomies the target isn't attached to, SEO, and links pointing at the original.

Duplicating within a collection is unchanged apart from the confirmation step, and now carries the entry's taxonomy terms to the copy.
