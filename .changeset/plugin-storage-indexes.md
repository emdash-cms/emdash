---
"emdash": patch
---

Fixes plugin-declared storage indexes never being created. Indexes declared in a plugin manifest's `storage` section are now materialized on marketplace/registry install and update, dropped on uninstall, and synced for configured plugins on the scheduler tick — so plugin storage queries (like the audit-log dashboard widgets) use an index instead of scanning the whole table. The index shape also changed to a composite that SQLite actually uses on D1, where table statistics are never collected.
