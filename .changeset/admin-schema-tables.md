---
"@emdash-cms/admin": patch
---

Updates the Content Types, Block types, Relations, and Byline Schema tables in the admin to match the content list's look, and fits them on phones.

- On the Content Types page, Edit and Delete move into each row's "…" menu, and code-defined collections offer Edit only. Block types now show as a table below content types.
- On the Relations page, clicking a relation's slug opens it for editing, and Edit and Delete move into the row's "…" menu.
- On the Byline Schema page, clicking a field's label opens it for editing, and Edit, Move up, Move down, and Delete move into the row's "…" menu.

On narrow screens, the buttons in the Content Types, Relations, and Byline Schema page headers move onto their own line instead of running off the edge or crowding the page title. On narrow tables, slugs, sources, types, and link, field, and version counts show under each row's name, and the less important columns fold away.

Browser tests that clicked a row's own Edit or Delete button, such as "Delete Posts", now need to open the "Actions for Posts" menu first. The Delete items keep their "Delete {name}" names, and the Content Types Edit item keeps "Edit {name}". On Relations and Byline Schema, "Edit {name}" now names the row's slug or label button, which opens the editor without the menu. The byline field reorder items are named "Move up" and "Move down" instead of `Move "{label}" up` and `Move "{label}" down`.
