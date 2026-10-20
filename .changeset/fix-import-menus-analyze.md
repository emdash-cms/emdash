---
"emdash": patch
---

Includes navigation menus in the WordPress plugin import analysis so the review screen lists them before executing the import. Previously, menus were imported during execution but never shown during the analyze step, making it impossible to know whether the source site had menus.

Reports skipped menus when a same-named menu already exists during import. The execute result now includes a `skipped` count alongside `created` and `items`, matching the pattern used by comment imports.
