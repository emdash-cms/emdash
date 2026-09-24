---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes Portable Text image blocks seeded with `$media`, including those seeded with earlier versions, rendering with an empty `src` and losing their media reference when first edited in the admin or through visual editing. Seeding now stores the image as a regular media reference with its alt text and dimensions on the block, the same shape the editor saves. Blocks whose media reference an earlier edit already removed need their image selected again.
