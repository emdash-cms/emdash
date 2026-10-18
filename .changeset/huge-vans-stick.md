---
"emdash": patch
---

Fixes menu item create, update, and reorder requests accepting missing, cross-menu, or cyclic parents that can hide items from rendered menus. Invalid parent changes now return a validation error without changing the menu; reorder validation uses the final state of the batch.

Unchanged parent links from older writes do not block label edits or reorders, so menus with legacy invalid data remain editable.
