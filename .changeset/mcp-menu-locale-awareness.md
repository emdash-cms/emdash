---
"emdash": patch
---

Make the MCP menu write tools locale-aware by exposing `locale` on `menu_create`,
`menu_update`, `menu_delete`, and `menu_set_items`, exposing `translationOf` on
`menu_create`, and teaching `handleMenuSetItems()` to target the requested locale
and tag inserted menu items with that menu's locale.

`handleMenuUpdate()`, `handleMenuDelete()`, and `handleMenuSetItems()` now fail
loud with the new `AMBIGUOUS_LOCALE` error code (HTTP 400) when called with a
`name` that exists in multiple locales and no `locale` is provided. Previously
the lookup silently picked an arbitrary translation, which could rewrite or
delete the wrong locale's menu on multi-locale installs. Single-locale installs
and callers that already pass `locale` are unaffected.
