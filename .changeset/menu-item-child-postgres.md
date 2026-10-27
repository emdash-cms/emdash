---
"emdash": patch
---

Fixes creating a child menu item through the menu items API on PostgreSQL. A request with a `parentId` and no `sortOrder` failed; the item is now placed after its existing siblings.
