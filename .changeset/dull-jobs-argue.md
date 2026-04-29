---
"emdash": patch
---

Fixes data loss in the visual-editing inline editor for plugin-contributed Portable Text block types. Previously, custom blocks like `marketing.hero` lost every field except `id` when the page was opened in edit mode, and the next save persisted the loss. Blocks now round-trip losslessly and render as a read-only placeholder labelled with the block type.
