---
"@emdash-cms/plugin-forms": patch
---

Fixes the `FormEmbed` textarea so it starts empty instead of containing indentation from the component source. Previously the caret began on a second line, an untouched `required` textarea passed the browser's validation, and the stray whitespace also surrounded a configured default value and returned after a successful submit reset the form.
