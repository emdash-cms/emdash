---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the admin Trash tab on multilingual sites, where it listed trashed entries from every locale regardless of the locale picker. Trash now follows the same locale filter as the All tab and shows a Locale column, so switching locales narrows the trash to that locale's entries.

`GET /_emdash/api/content/{collection}/trash` accepts an optional `locale` query parameter to scope the listing, and each item in the response now carries `locale` and `translationGroup`. Omitting `locale` still returns every locale, so existing API callers are unaffected.
