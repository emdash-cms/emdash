---
"@emdash-cms/admin": patch
---

Makes Buttons blocks editable in the rich text editor. Imported WordPress button groups now open a form for their layout and for each button's text, URL and style, and `/buttons` inserts a new group. Sites with a plugin that registers its own `buttons` block keep using that plugin's editor.
