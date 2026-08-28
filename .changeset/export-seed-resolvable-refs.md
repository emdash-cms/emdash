---
"emdash": patch
---

Fixes `emdash export-seed --with-content` so `reference` field values survive a round trip through `emdash seed`. The export now names a reference's target by the seed id it assigns that entry, and writes a referenced collection before the collection pointing at it. Previously the export emitted the source database's row id, which the restored database does not carry: the literal `$ref:<row-id>` string was stored in the column, the restore reported success, and the reference was lost wherever it was rendered.
