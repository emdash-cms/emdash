---
"@emdash-cms/admin": patch
---

Fixes the content list, Users, and Bylines tables running past the edge of phones and other narrow screens, which hid each row's "…" menu until you scrolled sideways. Each table now folds its less important columns away while the table itself is narrow, including when the sidebar leaves it little room, and brings them back when there is room. Tables 42rem (672px) and wider still show every column they showed before.

- On the content list below 42rem, such as on phones and portrait tablets, each entry's status, locale, and date show under its title, and a sort menu replaces the hidden sortable headers. Columns from the collection's list settings and from plugins are hidden there. The Trash tab shows each entry's locale and deleted date under its title the same way.
- On the Users page below 28rem (448px), the role shows under the email, with Disabled for a disabled user. Last Login and Passkeys are hidden below 42rem.
- On the Bylines page below 28rem, the byline type shows under the bio or slug. Website is hidden below 42rem, and now shows on any table that wide instead of only on screens 1024px and wider.

Hidden values still show when you open the entry, user, or byline, except values that only a plugin column displays. Long emails and slugs wrap, long words in titles break on narrow tables, and long bios truncate, instead of widening the table. The content list and Users page headers move their button to its own line when a long translation leaves no room beside the title.
