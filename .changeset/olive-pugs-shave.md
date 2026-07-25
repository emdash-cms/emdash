---
"emdash": patch
---

Fixes backups and preview snapshots failing on PostgreSQL. Downloading a backup, running "Back up now", and the daily automatic backup all errored with `relation "sqlite_master" does not exist`, and the daily run failed silently — the Backups screen reported the feature as enabled and storage as available while producing no archives. Snapshot generation now uses dialect-aware table, column, and published-status queries, so it works on PostgreSQL as it already did on SQLite and D1.
