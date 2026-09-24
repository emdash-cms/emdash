---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes Portable Text image blocks seeded with `$media`, including those seeded with earlier versions, rendering with an empty `src` and losing their media reference when first edited in the admin. Blocks whose media reference an earlier edit already removed need their image selected again.
