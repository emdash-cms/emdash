---
"emdash": patch
---

`SchemaRegistry.updateField` (and `emdash seed --on-conflict update`) no longer silently ignore a field's `type` change (#1397). Previously, changing a field's type in `seed.json` and re-seeding reported success and bumped the updated count while leaving `_emdash_fields.type`/`column_type` at their old values, so generated types and column mappings went stale with no warning. `UpdateFieldInput` now accepts `type`: a change whose underlying column type is unchanged (e.g. `string` → `slug`, both `TEXT`) is applied, and a change that would alter the column type (e.g. `text` → `portableText`, `TEXT` → `JSON`) is rejected with a clear `FIELD_TYPE_COLUMN_CHANGE` error pointing to the need for a manual content migration, instead of silently corrupting the metadata.
