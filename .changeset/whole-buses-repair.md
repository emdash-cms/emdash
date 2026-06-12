---
"@emdash-cms/admin": patch
---

Fixes nested-list serialization in the Portable Text editor. `convertList` now recurses into nested `bulletList`/`orderedList` children and emits each block with the correct `level` value, so Tab-indented list items in the editor round-trip through `onChange` as real nested portable-text blocks instead of being flattened to a single top-level list with every item at `level: 1`.
