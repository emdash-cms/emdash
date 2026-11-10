---
"@emdash-cms/admin": patch
---

Makes Buttons blocks editable in the rich text editor. Imported WordPress button groups now open a form for their layout and for each button's text, URL and style, and `/buttons` inserts a new group. Saving a group clears a link URL that an earlier editor stored on the group itself, so its card no longer shows that link. Sites with a plugin that registers its own `buttons` block keep using that plugin's editor.
