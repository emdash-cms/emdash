---
"emdash": patch
---

Fixes translating a menu on Cloudflare D1, which failed for larger menus and left an empty translated menu behind. On D1, translating or deleting a menu and reordering or replacing its items now either save completely or leave the menus unchanged.

#### What should I do?

If translating a menu failed before, delete the empty translated menu it left behind, then translate the menu again.
