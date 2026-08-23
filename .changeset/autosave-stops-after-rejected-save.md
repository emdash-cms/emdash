---
"@emdash-cms/admin": patch
---

Fixes the content editor's autosave so that a draft that the server rejected, such as a field value that exceeds its `maxLength`, is not resent every few seconds. The editor keeps the unsaved changes and tries again only after the content changes.
