---
"emdash": patch
---

Fixes WordPress WXR imports overcounting skipped items. The "skipped (already exists)" count in the admin, and the `skipped` value returned by `POST /_emdash/api/import/wordpress/execute`, now only include entries whose slug already exists in the target collection and locale. Menu items, reusable blocks (imported as sections), revisions and post types you disabled are no longer counted. The "X of Y" progress shown during the import no longer runs past the number of selected items.
