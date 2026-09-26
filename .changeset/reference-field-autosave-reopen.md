---
"@emdash-cms/admin": patch
---

Fixes reference fields showing "No references selected." when an entry is reopened in the admin within a minute of an autosave, publish, or schedule change. Adding a reference after such a reopen no longer removes the entries that were already saved.
