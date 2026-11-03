---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds **Settings > Sidebars**, where each admin user hides and reorders entries in the admin navigation and sections in the content editor's settings sidebar. Every role can open it from the user menu. The layout is saved to the user's account, so it follows them to every browser, and it changes nobody else's sidebars.

- Navigation entries move within their group or folder. Dashboard always stays first and visible. `admin.hiddenNavItems` still hides entries for everyone, and those entries don't appear on the page.
- The editor sidebar order applies to every collection and to new entries. Publish can move but can't be hidden.
- Reset restores a list's default and offers Undo.

The editor settings sidebar no longer shows a drag handle on each section. A **Customize sidebar** link after the last section opens the new page, and a pencil at the bottom of the navigation does too. Section orders that the drag handles saved in a browser are not carried over, so every user starts from the default order.

`GET /_emdash/api/auth/me` returns the stored layout as `adminLayout`, or `null`. `POST /_emdash/api/auth/me` accepts `{ "action": "setAdminLayout", "adminLayout": { ... } }` to replace it, or `"adminLayout": null` to remove it. A layout is limited to 200 IDs per list and 16 KB.

Browser tests that used the editor sections' "Drag to reorder …" buttons need to change, because those buttons no longer exist. Byline reorder handles are unchanged.
