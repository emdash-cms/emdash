---
"emdash": patch
---

Fixes site settings updates during a running export so the export's `write_epoch` bump happens inside the same transaction. If the export fence cannot record the write, the settings update now rolls back instead of committing invisibly to the export.
