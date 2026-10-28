---
"@emdash-cms/admin": patch
---

Moves the buttons at the end of each content list row into one "…" menu. On the All tab, the menu has Edit and Move to trash, plus View published for published entries and Duplicate for entries you can duplicate. On the Trash tab, it has Restore and Delete permanently. Clicking an entry's title still opens it for editing.

The All and Trash tables also have a new look, with column headers on a tinted band above the rows.

Fixes the Move to trash and Delete permanently confirmations staying open after you confirm. They now close right away, including when the action fails, and a toast reports the error.

Browser tests that clicked a row's own buttons, such as "Edit My post", now need to open the "Actions for My post" menu first.
