---
"@emdash-cms/admin": patch
---

Fixes the content editor refusing every later save once another writer changed the same entry, so what you typed is kept and can be saved over the newer version. Autosave pauses for that entry until you decide, so your copy never goes over the other version without you choosing it.
