---
"@emdash-cms/plugin-forms": patch
---

Fixes conditional form fields remaining visible when their condition is false by adding `.ec-form-field[hidden] { display: none; }` to the default stylesheet.
