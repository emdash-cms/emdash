---
"@emdash-cms/admin": patch
---

Fixes silent save failures when creating content in the admin: a rejected create — for example a slug that already exists in the collection — now shows a "Failed to save" toast with the server's message instead of doing nothing.
