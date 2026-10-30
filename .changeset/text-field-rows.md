---
"@emdash-cms/admin": patch
---

Fixes the `rows` widget option on `text` fields having no effect in the content editor. A text field that sets `options.rows` to a positive whole number now renders a textarea with that many rows, so fields that already set it change height after upgrading. Text fields without the option keep the 10-row default.
