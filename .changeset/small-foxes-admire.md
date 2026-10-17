---
"emdash": patch
---

Fixes duplicate menu items and widgets when concurrent first requests apply the same seed through D1 bindings. Menu and widget replacements are atomic on D1 bindings, transactional SQLite, and PostgreSQL, so a failed replacement retains the previous items. This does not make replacements atomic on the Durable Object SQL backend.
