---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes deleting a menu item on SQLite, libSQL, and Cloudflare D1 so the items nested under it are deleted too, as they already were on PostgreSQL. Before, the nested items stayed behind: the site showed them as top-level menu items, but the menu editor no longer listed them, so they could not be edited or removed.

When a menu item has nested items, the menu editor's delete confirmation now says they will be deleted too.

Upgrading moves every menu item whose parent is missing from its menu to the top level, where the site already shows it, so the menu editor lists it again.

#### What should I do?

After upgrading, review your menus in the admin. Items left behind by an earlier delete now appear at the top level, where your site was already showing them. Delete any you no longer want.
