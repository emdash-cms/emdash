---
"@emdash-cms/admin": patch
---

Fixes the content editor saving outdated rich text over newer content. When the editor picked up a newer version of an entry, for example after a save from another tab, a plugin, or the API, rich text fields and rich text inside blocks kept the old text, and the next keystroke saved it over the newer version without a conflict notice. Discard changes left the discarded text in place the same way. A read that finished after an autosave could also undo it, so a later edit saved the earlier text.

Rich text typed while a save is in progress counts as unsaved and goes out with the next save, which shows the conflict notice if the entry changed elsewhere in the meantime.
