---
"@emdash-cms/admin": patch
---

Fixes recent edits to an existing entry being lost when you leave the content editor right after typing. Following a link to another admin page now sends those edits before leaving, and the next page shows "Autosave failed" if they don't go through. When the edits can't be sent, for example after a conflict, the editor asks before leaving. Reloading or closing the tab before they are saved shows the browser's prompt.
