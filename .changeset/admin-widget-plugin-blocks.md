---
"@emdash-cms/admin": patch
---

Threads plugin block definitions and the block sidebar callbacks through the Widgets admin UI. `WidgetEditor` now passes `pluginBlocks`, `onBlockSidebarOpen`, and `onBlockSidebarClose` into its nested `PortableTextEditor`, and renders `ImageDetailPanel` when the image block panel is opened. Without this, custom plugin block types inside widget content (image, marker blocks, etc.) had no configuration UI — the settings button and media picker did nothing. Behavior now matches the content-entry editor.
