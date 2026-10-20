---
"@emdash-cms/admin": patch
---

Fixes recent edits to an entry being overwritten with an older copy when you switch to another entry and back while their autosave is still on its way. Once the autosave finishes, the editor now shows the autosaved edits. Changing the older copy before then still saves it over them.
