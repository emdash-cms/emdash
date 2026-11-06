---
"@emdash-cms/admin": patch
---

Fixes the content editor discarding edits made to the slug and to fields other than rich text and blocks while a manual save is in progress. The edits stay in the form when the saved entry reloads, and the next autosave saves them.
