---
"@emdash-cms/admin": patch
---

Fixes the content editor discarding a slug edit made while a manual save is in progress. The slug stays in the form when the saved entry reloads, and the next autosave saves it.
