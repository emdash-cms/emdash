---
"@emdash-cms/admin": patch
---

Fixes the Portable Text editor asking for a URL when inserting a plugin block that declares `fields: []`, and saving what was typed as the block's `id`. Choosing the block in the slash menu now inserts it straight away, and its card no longer shows **Edit URL**.
