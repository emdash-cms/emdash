---
"@emdash-cms/admin": patch
---

Fixes image field removal not persisting after save by sending null instead of undefined, which JSON.stringify was silently dropping.
