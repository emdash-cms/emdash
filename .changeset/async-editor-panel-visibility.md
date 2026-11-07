---
"@emdash-cms/admin": minor
---

Adds optional `isVisible(ctx)` checks to native content editor panels. Plugin authors can return a boolean or `Promise<boolean>` using the same collection, saved entry, and locale context as the panel component, for example `isVisible: async ({ collection }) => isEnabledCollection(collection)`.

The entire section stays hidden until the check returns `true`, avoiding empty plugin headings when visibility depends on asynchronously loaded settings. Failed checks hide the panel and log its plugin and panel IDs without unmounting the editor. Panels without `isVisible` retain their existing behavior, and `collections` and `minRole` still filter panels before visibility checks run.

Checks rerun when the saved entry changes, including after autosaves. Panels with `isVisible` unmount during each recheck and mount again only if it returns `true`, even when the check is synchronous. Keep state that must survive saved-entry updates outside the panel component, and cache shared settings requests in your plugin.
