---
"@emdash-cms/blocks": minor
---

Adds row actions to Block Kit tables and a new `menu` element. Set a table column's `format` to `"element"` to place a `button`, `link`, or `menu` in each row under that column's key. A `menu` is a button that opens a list of choices; choosing one sends a `block_action` with the menu's `action_id` and the choice's `value`. Menus also work in `actions` blocks, section accessories, and empty-state actions, but not as form fields. Build one with `elements.menu(actionId, label, items, { style })`; the `MenuElement` type is exported. Existing tables and elements are unchanged.
