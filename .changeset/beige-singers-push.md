---
"@emdash-cms/plugin-forms": patch
---

Fixes autoresponder recipients and notification Reply-To addresses on forms with multiple email fields. Forms now use the first filled required email field, falling back to the first filled email field, so an earlier optional business email does not override the submitter's required address.
