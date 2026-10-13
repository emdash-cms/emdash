---
"emdash": patch
---

Fixes visual editing for empty Portable Text fields, such as the body of a new post. Edit mode now renders the inline editor for them, so the field can be written on the page instead of having no editor at all. The empty editor stays blank until it is clicked, then shows a "Type / for commands..." hint. In edit mode, an empty Portable Text field reads as an empty array instead of `null`.
