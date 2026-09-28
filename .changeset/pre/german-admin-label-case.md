---
"@emdash-cms/admin": patch
---

Fixes collection and taxonomy names appearing in lowercase inside sentences of the German admin, such as "Noch keine kategorien vorhanden." on a taxonomy page or "beiträge durchsuchen..." in a content list's search field. German capitalizes nouns, so the German admin now shows these names as the site defines them. Other admin languages still lowercase them.

In admin languages other than English, the dialogs for creating, editing and deleting terms now show the translated word for "term" instead of the English one when the taxonomy has no singular name, such as a taxonomy created in the admin.
