---
"emdash": patch
---

Fixes the child items of a deleted menu item staying behind on SQLite and D1, where they still showed at the top level of the public menu but no longer in the admin menu editor. Deleting a menu item now deletes the items nested under it too.

#### What should I do?

Child items left behind by earlier deletes are not removed, so they still show at the top level of the public menu. To remove one, find it in the response of `GET /_emdash/api/menus/{name}` and delete it with `DELETE /_emdash/api/menus/{name}/items/{id}`. If the menu has translations, add `?locale={locale}` for the affected translation to both requests: without it, `GET` returns only one translation, and `DELETE` fails with `AMBIGUOUS_LOCALE`.
