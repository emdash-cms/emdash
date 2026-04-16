---
"@emdash-cms/admin": patch
---

Wires up the block configuration sidebar inside `WidgetEditor`. `PortableTextEditor` now receives `onBlockSidebarOpen`/`onBlockSidebarClose` callbacks that hold the active `BlockSidebarPanel` in local state, and renders `ImageDetailPanel` when the panel type is `"image"` — mirroring the content-entry editor. Without this, clicking a block's settings button or the media picker inside widget content had no visible effect.
