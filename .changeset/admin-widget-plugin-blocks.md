---
"@emdash-cms/admin": patch
---

Passes plugin block definitions into the `PortableTextEditor` nested inside `WidgetEditor`, so custom plugin-registered block types (image blocks, marker blocks, etc.) can be inserted and rendered inside content-type widgets. The manifest is fetched with react-query in the top-level `Widgets` component, flattened into a `PluginBlockDef[]` list, and threaded through `WidgetAreaPanel` → `WidgetItem` → `WidgetEditor`.
