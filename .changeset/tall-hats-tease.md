---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes responsive table widths in the admin editor with Tiptap 3.32.0. Gives both editors' textboxes accessible names for screen readers.

Pins the editor's Tiptap dependencies to exactly 3.32.0 so installations use the version covered by the editor tests. Code-block highlighting keeps its existing lowlight extension version. Sites or plugins that share Tiptap dependencies with EmDash should align them to 3.32.0 to avoid installing multiple copies.

Links applied at an empty caret now end when you type a space, following Tiptap's updated behavior. In the visual editor, typing a space at the end of an existing link also ends the link. Text typed after that space is not part of the link.
