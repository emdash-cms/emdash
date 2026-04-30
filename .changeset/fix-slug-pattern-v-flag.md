---
"@emdash-cms/admin": patch
---

Fixes slug-style `<input pattern="...">` attributes so HTML form validation works in current browsers. The patterns used `[a-z0-9-]+`, which is rejected as `Invalid character class` when compiled with the `v` (unicode-sets) flag — the mode browsers now use for the `pattern` attribute. The dangling `-` is now escaped (`[a-z0-9\-]+`), restoring slug validation in the Sections list/edit, Menus list, and Widgets create-area dialogs. Resolves #845.
