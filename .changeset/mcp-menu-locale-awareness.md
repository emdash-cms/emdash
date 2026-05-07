---
"emdash": patch
---

Make the MCP menu write tools locale-aware by exposing `locale` on `menu_create`,
`menu_update`, `menu_delete`, and `menu_set_items`, exposing `translationOf` on
`menu_create`, and teaching `handleMenuSetItems()` to target the requested locale
and tag inserted menu items with that menu's locale.
