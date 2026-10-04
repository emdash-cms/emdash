---
"@emdash-cms/admin": patch
---

Adds European Portuguese (Português (Portugal), `pt-PT`) translations for the admin UI. The locale is selectable from the language picker and uses Portuguese date formats in the calendar and date settings. Browsers that ask for `pt-PT` now get this locale instead of Brazilian Portuguese, and a site whose language is set to `pt-PT` sends its invite, sign-in and recovery emails in European Portuguese. Other Portuguese variants, and plain `pt`, still resolve to Brazilian Portuguese.
