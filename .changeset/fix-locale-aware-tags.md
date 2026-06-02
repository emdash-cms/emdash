---
"emdash": patch
"@emdash-cms/admin": patch
---

Fix taxonomy terms not being locale-aware in the content editor (#1218). Term assignments are stored against the per-locale content row while the term's `translation_group` spans every locale, so resolving terms for an entry must scope to the entry's locale. The content terms endpoint (`/content/:collection/:id/terms/:taxonomy`) now derives the entry's locale server-side and passes it to `getTermsForEntry`, and the admin `TaxonomySidebar` threads the entry locale through its fetch/save calls (and into its React Query keys, so switching translations refetches). Previously a localized post showed and applied every locale variant of a tag instead of just the variant for its own locale.
