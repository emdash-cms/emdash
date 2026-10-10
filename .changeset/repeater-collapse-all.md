---
"@emdash-cms/admin": minor
---

Adds a **Collapse all** / **Expand all** control to `repeater` fields in the content editor, so a long repeater can be reduced to its row summaries without collapsing every row in turn.

The control sits in the field header next to **Add Item**, and appears once the repeater holds at least one row. It offers the one action that is useful for the current state: while any row is open it reads **Collapse all**, and once every row is closed it reads **Expand all**. A row added while the repeater is collapsed opens expanded, so the inputs for the new row are immediately available. Each row's own header still toggles that row on its own, and collapse state stays a view concern — it is not saved with the entry.
