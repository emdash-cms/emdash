---
"@emdash-cms/admin": patch
---

Fixes the content editor saving an outdated rich text body over newer content. When the editor picked up a newer version of an entry while it had no unsaved edits, for example after a save from another tab, a plugin, or the API, the body kept the old text, and the next keystroke saved it over the newer version without a conflict notice. Discard changes left the discarded text in the body the same way. A read that finished after an autosave could also undo it, so a later edit saved the earlier text.
