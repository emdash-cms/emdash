---
"@emdash-cms/auth": patch
---

Fixes authentication dates loaded from SQLite being shifted by the Node.js server's local time zone when the stored value has no explicit offset.
