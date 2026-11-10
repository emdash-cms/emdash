---
"@emdash-cms/admin": patch
---

Fixes the content editor silently overwriting another editor's changes after a background refresh followed by undoing unsaved edits. The next save now reports a conflict instead of sending older field values with the newer revision token.
