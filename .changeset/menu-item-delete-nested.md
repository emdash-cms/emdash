---
"emdash": patch
---

Fixes deleting a menu item on SQLite, libSQL, and Cloudflare D1 so the items nested under it are deleted too, as they already were on PostgreSQL. Before, the nested items stayed behind: the site showed them as top-level menu items, but the menu editor no longer listed them, so they could not be edited or removed.
