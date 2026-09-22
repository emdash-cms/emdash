---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the content editor reporting a failed save with the field's slug and the validator's wording, such as `excerpt: Too big: expected string to have <=160 characters`. When a save, autosave, new entry or new translation fails field validation, the error toast now names each field by the label the editor shows and says what the field needs, for example "Summary can have at most 160 characters."
