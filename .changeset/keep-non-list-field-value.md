---
"@emdash-cms/admin": patch
---

Fixes the admin silently replacing a stored value that is not a list on the first edit to a repeater, rich text, multi-select, or blocks field, or to a repeater in a plugin block. Such values come from imports, direct database writes, or a plugin that changed a block field from a text input to a repeater. The field now shows the stored value read-only with a warning and keeps it unchanged until the editor chooses to replace it with an empty list.
