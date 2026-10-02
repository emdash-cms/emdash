---
"@emdash-cms/admin": patch
---

Fixes two problems with number fields in the content editor. Clearing a number field now saves it as empty instead of `0`, which previously failed a field's minimum (such as `min: 1`) or silently stored zero. Decimal values such as `4.50` no longer block the Save button with the browser's "nearest valid values" message.
