---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` when resuming a seeded collection deletion. Imports now wait for their own scaffold deletions, and report failed deletions with cleanup retry instructions.

New imports are refused while any collection deletion is unfinished, including cleanup left after the collection disappears from the schema. Wait for cleanup to finish before starting an import. Transfer analysis reports the collection slug, state, and phase, and the admin names the collection whose deletion is blocking the import.
