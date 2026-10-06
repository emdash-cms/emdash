---
"@emdash-cms/admin": patch
---

Fixes false conflict errors when saving SEO fields, including OG images, after a clean content editor refreshes a cached entry. Background refreshes preserve unsaved edits and their conflict protection, and delayed older reads cannot replace the revision from a successful save.
