---
"@emdash-cms/admin": patch
---

Updates the term list on the Categories, Tags, and custom taxonomy pages to the content list's table layout, which fits phones.

- Clicking a term's name opens it for editing, and the term's other actions sit in its row's "…" menu. On Categories and custom taxonomies, that menu holds the Edit, Move, Translate, and Delete buttons that were in each row; on Tags, the Edit button moved into it.
- A term that is the only one under its parent, or the only top-level term, no longer shows Move up and Move down. A term whose parent has no translation in the current locale shows them disabled, and its menu says why, on touch screens and to screen readers too.
- Deeply nested terms keep their "…" menu in view on phones, and the header buttons on Categories and custom taxonomy pages wrap onto a new line on narrow screens instead of running off the edge.

Browser tests that clicked a term's Move, Translate, or Delete button need to open "Actions for {name}" first, and tests that opened "More actions for {name}" on a tag open "Actions for {name}" instead. In that menu, Delete is named "Delete {name}" on every taxonomy, and the other items are "Move up", "Move down", and "Translate". The term's name is the button "Edit {name}", which opens the editor without the menu.
