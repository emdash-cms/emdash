---
"emdash": patch
---

Make the MCP menu write tools locale-aware by exposing `locale` on `menu_create`,
`menu_update`, `menu_delete`, and `menu_set_items`, exposing `translationOf` on
`menu_create`, and teaching `handleMenuSetItems()` to target the requested locale
and tag inserted menu items with that menu's locale.

All seven menu-name lookups (`handleMenuUpdate`, `handleMenuDelete`,
`handleMenuSetItems`, `handleMenuItemCreate`, `handleMenuItemUpdate`,
`handleMenuItemDelete`, `handleMenuItemReorder`) now fail loud with the new
`AMBIGUOUS_LOCALE` error code (HTTP 400) when called with a `name` that exists
in multiple locales and no `locale` is provided. Previously the lookup silently
picked an arbitrary translation, which could rewrite or delete the wrong
locale's menu on multi-locale installs. The error message lists the available
locales so callers can recover. Single-locale installs and callers that already
pass `locale` are unaffected.

The `translationOf` → `locale` requirement is now enforced inside
`handleMenuCreate` (returns `VALIDATION_ERROR`), so REST/SDK callers get the
same guard the MCP boundary already provided.
