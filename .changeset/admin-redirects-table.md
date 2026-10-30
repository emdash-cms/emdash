---
"@emdash-cms/admin": patch
---

Updates the Redirects page's redirect and 404 tables to match the content list's look, and fits them on phones.

- Each redirect shows its destination under its source, after an arrow, and long paths wrap instead of being cut off. A 410 or 451 rule, which has no destination, shows its source alone. Clicking a redirect's source opens it for editing, and Edit and Delete move into the row's "…" menu. The enable switch, the loop warning, and the "auto" badge stay on the row, and disabled redirects still look faded.
- When a table is narrower than 42rem (672px), such as on phones and portrait tablets, the Code and Hits columns fold away and show under each redirect, and the 404 table's Last seen column folds under each path. Below 28rem (448px), such as on phones, the 404 table's Hits column folds under each path too. A folded hit count reads like "12 hits". Nothing scrolls sideways on a 320px screen.
- The 404 table's Create redirect and Mark as Gone (410) buttons match the admin's other buttons and keep their names, their tooltips, and the Mark as Gone (410) button's description for screen readers.

Browser tests that clicked a redirect's "Delete redirect {source}" button need to open the "Actions for redirect {source}" menu first, where Delete is a menu item with that name. "Edit redirect {source}" now names the source path itself, which is a button, so `button[aria-label^="Edit redirect"]` finds the source. The Source and Destination headers are one column header, named "Source Destination". The 404 buttons no longer have a `title` attribute: their tooltips are popups, and the Mark as Gone (410) button's explanation is its accessible description through `aria-describedby`. A redirect's code and a 404's last seen date are in the row twice, under the path and in their own column, with one copy hidden at any width, so tests that look up that text need to scope it to a cell. A hit count shows as a bare number in the Hits column and as, for example, "12 hits" or "1 hit" under the path.
