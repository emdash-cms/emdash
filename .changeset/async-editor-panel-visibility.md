---
"@emdash-cms/admin": minor
---

Adds optional `isVisible(ctx)` checks to native content editor panels. Plugin authors can return a boolean or `Promise<boolean>` using the same collection, saved entry, and locale context as the panel component, for example `isVisible: async ({ collection }) => isEnabledCollection(collection)`.

The entire section stays hidden until the check returns `true`, avoiding empty plugin headings when visibility depends on asynchronously loaded settings. Failed checks hide the panel and log its plugin and panel IDs without unmounting the editor. Existing panels remain visible by default, and `collections` and `minRole` still filter panels before visibility checks run.
