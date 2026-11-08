---
"@emdash-cms/admin": minor
---

Adds optional `isVisible(ctx)` checks to native content editor panels. Plugin authors can return a boolean or `Promise<boolean>` using the same collection, saved entry, and locale context as the panel component, for example `isVisible: async ({ collection }) => isEnabledCollection(collection)`.

The entire section stays hidden until its first check returns `true`, avoiding empty plugin headings when visibility depends on asynchronously loaded settings. Failed checks hide the panel and log its plugin and panel IDs without unmounting the editor. Panels without `isVisible` retain their existing behavior, and `collections` and `minRole` still filter panels before visibility checks run.

The first check for a collection, entry ID, and locale keeps the section hidden until it returns `true`. Checks rerun when the saved entry changes, including after autosaves, saves, and publication. During these rechecks, the section keeps its last visibility decision so visible panels stay mounted and retain local state. A result other than `true`, a throw, or a rejection hides the section when the check settles. Superseded results and errors are ignored.
