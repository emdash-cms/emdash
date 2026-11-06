---
"@emdash-cms/plugin-forms": patch
---

Fixes the autoresponder and the notification Reply-To using a form's first email field even when it is optional. On a form with an optional business address before the submitter's own, the confirmation went to the business address, or nowhere when that field was left empty. They now use the first required email field that has a value, then any filled email field.
