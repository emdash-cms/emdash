---
"@emdash-cms/admin": patch
---

Fixes autosave form reset bug. Autosave no longer invalidates the query cache, preventing form fields from reverting to server state after autosave completes.
