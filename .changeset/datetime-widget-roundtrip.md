---
"@emdash-cms/admin": patch
---

Fixes the `datetime` field widget so existing values display in the editor and new values pass server validation. The widget passed raw ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) into `<input type="datetime-local">`, which silently rendered empty, and emitted `YYYY-MM-DDTHH:mm` on save, which the field's zod schema rejected. Strips the suffix for display, appends `:00.000Z` on save, and normalizes date-only stored values to UTC midnight for the input. Applies to the top-level `datetime` widget in the content editor and the `datetime` sub-field type inside `RepeaterField`.
