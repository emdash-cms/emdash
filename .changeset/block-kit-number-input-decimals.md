---
"@emdash-cms/blocks": patch
"@emdash-cms/admin": patch
---

Fixes decimal validation for `number_input` in Block Kit forms and sandboxed field widgets. Values such as `5.25` without a minimum and `5.00` with a minimum of `0.01` now save. Sandboxed field widgets also enforce their declared `min` and `max` bounds.
