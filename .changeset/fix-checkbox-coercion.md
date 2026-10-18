---
"@emdash-cms/plugin-forms": patch
---

Fixes single checkbox fields so a checked box is stored as `true` when the default submitted value is `"1"`. Required checkbox fields that are not checked are still rejected during validation.
