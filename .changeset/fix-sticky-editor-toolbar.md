---
"@emdash-cms/admin": patch
---

The rich-text editor formatting toolbar now stays pinned to the top of the editing area while scrolling through long posts, instead of scrolling out of view. The toolbar uses `position: sticky` and the editor wrapper switched from `overflow-hidden` to `overflow-clip` so corners stay clipped without creating a nested scroll container that would break sticky positioning. Distraction-free / minimal editors (e.g. Widgets) are unaffected since they don't render the toolbar.
