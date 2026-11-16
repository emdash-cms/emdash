---
"@emdash-cms/admin": patch
---

Adds Italian (Italiano) translations for the whole admin interface and makes Italian selectable in the language picker on the sign-in page and in Settings. Browsers that prefer Italian now get the Italian admin automatically, and a site whose language is set to Italian sends its invite, sign-in and recovery emails in Italian. To keep Italian out of the admin, leave `it` out of the `admin.locales` option.
