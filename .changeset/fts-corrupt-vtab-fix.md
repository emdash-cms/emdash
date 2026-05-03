---
"emdash": patch
---

Fixes `SQLITE_CORRUPT_VTAB` (`database disk image is malformed`) when editing or publishing content on collections that have search enabled, and on restore-from-trash, permanent-delete, and edit-while-trashed flows.

The FTS5 sync triggers used the contentless-table form (`DELETE FROM fts WHERE rowid = OLD.rowid`) on what is actually an external-content FTS5 table. After an UPDATE on `ec_<collection>`, FTS5 then read NEW column values from the (already updated) content table while trying to remove OLD tokens from the inverted index, drifting the index out of sync until SQLite refused further reads. Rewrites the triggers to use the documented external-content-safe `INSERT INTO fts(fts, rowid, ...) VALUES('delete', OLD.rowid, OLD.col1, ...)` pattern, gated on `OLD.deleted_at IS NULL` so we don't try to remove rows that were never indexed (which would itself raise `SQLITE_CORRUPT_VTAB` on restore-from-trash and permanent-delete). Adds startup detection that rebuilds any FTS index whose triggers come from a pre-fix EmDash version, plus an `'integrity-check'` pass to `verifyAndRepairIndex` so any latent corruption from earlier mutations is repaired automatically rather than surfacing on the next mutation.
