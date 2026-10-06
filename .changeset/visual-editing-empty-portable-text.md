---
"emdash": patch
---

Fixes visual editing for empty Portable Text fields, such as the body of a new post. Edit mode now renders the inline editor with a "Type / for commands..." hint, so the field can be written on the page instead of showing nothing to click. In edit mode, an empty Portable Text field reads as an empty array instead of `null`.
