---
"@emdash-cms/admin": patch
---

Fix "Add Content" in the menu editor: the admin was sending the raw collection slug (e.g. `pages`) as the menu item `type`, which the API's `menuItemTypeEnum` rejects with a 400. Map the picker's collection to the correct enum value (`pages` → `page`, `posts` → `post`, everything else → `collection`) so picking a page or post actually adds it to the menu. (#1173)
