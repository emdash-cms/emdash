---
"@emdash-cms/admin": minor
---

Redesigns the admin's menu editor and Menus list so editors can build navigation with fewer dialogs.

- **Add items** opens one dialog that adds entries from any visible collection, taxonomy terms, archive pages ("All Posts"), custom links and headings. Editors can pick several items from different sources and add them together at the top level or inside a chosen item.
- Menu items appear in one list. Drag a row to reorder it, or drag it sideways to nest it. The same moves work from the keyboard through the row's drag handle and from each row's "⋯" menu.
- Each row shows where the item goes, such as a URL, an entry's path, "All Posts" or "Categories · Design". A badge marks items the site leaves out because the linked entry is a draft, in the trash or no longer exists.
- Menus list cards show a small drawing of each menu's top-level items.

The REST API, stored menus and site rendering don't change. A few editing behaviors do:

- The Edit dialog no longer has a **Parent** select. Drag the item or use its "⋯" menu to move it.
- New custom links take a label and URL. Set **Open in new tab** and **CSS classes** from the Edit dialog after adding the link.
- Turning **Open in new tab** off now clears the link's target, so a link that opened in a new tab can switch back.
- The editor nests items up to three levels deep. Deeper items created through the API or MCP still appear at their depth, but the editor doesn't move an item below the third level.
