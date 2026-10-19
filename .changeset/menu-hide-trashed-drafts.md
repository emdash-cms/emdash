---
"emdash": patch
---

Fixes menus showing dead links to entries that are in the trash or not published. `getMenu()` leaves those items out. In edit mode, menus still link to unpublished entries. With the object cache enabled, a cached menu now refreshes when an entry or taxonomy term it links to changes.
