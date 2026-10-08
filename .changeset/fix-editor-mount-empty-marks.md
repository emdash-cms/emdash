---
"@emdash-cms/admin": patch
---

Fixes the Portable Text editor firing an autosave immediately after opening an entry that ends in a non-paragraph block and contains empty `markDefs`/`marks` arrays. Opening an entry no longer creates a pending draft when the document is unchanged.
