---
"@emdash-cms/plugin-field-kit": minor
"emdash": patch
"@emdash-cms/admin": patch
---

Adds `@emdash-cms/plugin-field-kit` — composable field widgets for `json` fields. Four widgets (`object-form`, `list`, `grid`, `tags`) are configured entirely through seed `options` so site builders don't need to write React to get a usable editing UI. Widgets store clean JSON (no nesting, no mutation of shape), so removing the plugin leaves valid data in the database. See discussion #571 for background.

Widens `FieldDescriptor.options` to `Array<{ value: string; label: string }> | Record<string, unknown>` so plugin widgets can accept arbitrary widget config (not only enum choices). The array shape for `select` / `multiSelect` continues to work unchanged.
