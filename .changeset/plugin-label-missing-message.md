---
"@emdash-cms/admin": patch
---

Fixes the admin console filling with "Uncompiled message detected!" warnings for plugin sidebar and command palette labels that have no translation. A plugin page label is now looked up in the catalog only when the catalog has it; labels without a translation render as declared, as before, without a warning on every render.
