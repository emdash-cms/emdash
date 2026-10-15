---
"@emdash-cms/plugin-forms": patch
---

Fixes the daily digest. Creating a form with the digest on, or turning it on for an existing form, failed with an "Invalid task name" error, and a form created that way was saved with the digest on but never sent one. The digest is now scheduled, including for a duplicated form, and is rescheduled or cancelled when the form's digest settings change.
