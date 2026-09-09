---
"emdash": patch
---

Fixes visual editing on list pages. Entries from `getEmDashCollection` now carry a working `edit` proxy in edit mode, so spreading `{...entry.edit.title}` renders the annotation and the toolbar makes the element editable. Previously every collection entry received a no-op proxy in every mode, so only pages built from `getEmDashEntry` were click-to-edit — fields shown exclusively in a list, and collections with no detail page, could not be edited on the page at all.
