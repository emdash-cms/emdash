---
"emdash": patch
---

Fixes `portableTextToProsemirror` flattening nested lists whose subtree mixes `listItem` types. The outer run-grouping broke on the first nested type switch (e.g. an `orderedList` child under a `bulletList` parent), so an input like `[bullet L1, number L2, bullet L1]` was emitted as three separate top-level lists instead of one bullet list with a numbered sub-list under the first item. Internal `convertList`/`convertListItem` recursion was already correct — only the outer grouping needed to be widened to include `level > 1` blocks regardless of `listItem` type.
