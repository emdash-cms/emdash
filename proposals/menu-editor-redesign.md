---
title: A simpler menu editor and Menus list
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-11-27
---

# A simpler menu editor and Menus list

## Problem and user case

Editors build a site's header, footer and sidebar navigation in the admin's menu editor. Each entry takes its own trip through a dialog, nesting takes one Edit dialog per item, and most rows don't say what they link to.

- **Adding items.** **Add Content** opens a picker that adds one entry and closes. The picker lists entries only, so taxonomy terms and archive pages ("All Posts") can't be added from the admin, though the API and the site support both. **Add Custom Link** opens a second dialog that requires a URL, so editors type `#` to make a dropdown parent.
- **Nesting and order.** Each item is a separate bordered card with Move up and Move down buttons, which move an item among its siblings only. The only way to nest an item is the **Parent** select in the Edit dialog.
- **Reading the menu.** Custom links show their URL. Other items show a badge with their collection or taxonomy slug, such as `posts` or `category`, instead of the page they link to. An item that links to a draft, a trashed entry or a deleted term looks like any other row, though the site leaves it out of the menu.
- **The Menus list.** Every card has the same layout, with a label, the menu's name, an item count, and Edit and Delete buttons. None shows what's in the menu.

## Proposed behavior

Both pages keep their routes and breadcrumb trail. The editor keeps its rename and translation controls. While this proposal is in review, an [interactive prototype](https://emdash-menus-redesign-prototype.gifted-market-6ca.workers.dev) shows the real admin built as a static site, with the menu API kept in the browser's memory. Changes reset on reload, and the bar at the bottom switches to worst-case, empty, single-item and very long menus.

### The menu editor

The page header shows the menu's label with the rename button after its last word. When the menu has items, the header also has one **Add items** button. The "Edit menu items" subtitle, **Add Content** and **Add Custom Link** go away.

The items are one list card. Each row is 44px tall, rows are separated by a line, and each nesting level indents the row by 24px. Clicking anywhere on a row, outside its handle and "⋯" menu, opens the Edit dialog. A row shows:

- a drag handle, which appears when the pointer is over the row or the handle has focus, and always on touch screens;
- an icon for what the item links to: a page, another entry, an archive, a term (a folder icon for a hierarchical taxonomy, a tag icon otherwise), a custom link or a heading;
- the item's label;
- where the item goes, in muted text, plus an icon when the link opens in a new tab:
  - a custom link's URL;
  - an entry's path, built from its collection's URL pattern and slug, or its title when the collection has no URL pattern;
  - "All {collection}" for an archive;
  - "{taxonomy} · {term}" for a term;
  - "Heading" for a custom item whose URL is empty or `#`;
- a status badge when the site leaves the item out: "Draft · hidden on the site" for an entry that isn't published, including a scheduled one, "In trash · hidden on the site", or "Not found · hidden on the site";
- a "⋯" menu with **Edit**, **Add item inside**, **Move up**, **Move down**, **Indent**, **Outdent** and **Delete**.

```text
⠿  ⛓  Home                 /                                   ⋯
⠿  ≡  Blog                 All Posts                           ⋯
⠿     📁 Development       Categories · Development            ⋯
⠿  T  Resources            Heading                             ⋯
⠿     ▤ Work in progress   /posts/work-in-progress   [Draft · hidden on the site]  ⋯
⠿     ⛓ Docs               https://docs.example.com  ↗         ⋯
```

The site also leaves out everything nested under a hidden item. Only the hidden item shows a badge. Rows don't show an item's CSS classes; the Edit dialog does.

**Drag and drop.** Dragging a row up or down reorders it, and dragging it sideways changes its depth in 24px steps. The landing spot shows as a dashed outline at the depth the row will take, a dragged parent carries its children, and the lifted row follows the pointer up and down in an overlay. A drop sends one reorder request with every item's parent and position. The list updates at once. If the request fails, the list goes back to the order before that move, an error toast reads "Couldn't save the new order" with the server's message, and the editor reloads the menu. A successful reorder shows no toast.

**Keyboard and screen readers.** The handle is a button. Space or Enter lifts the row, the up and down arrow keys move it past one row, the left and right arrow keys change its depth, Space or Enter drops it, and Escape cancels. The left and right keys and the sideways drag mirror in right-to-left layouts. A screen reader hears where the row is, such as "Docs is inside Resources, position 2 of 2". The "⋯" menu offers the same moves without a drag, and keeps focus on the moved row's menu button.

**Depth.** The editor builds menus up to three levels deep: the top level and two nested levels. Indent, a sideways drag and **Add item inside** stop at the third level.

**Adding items.** **Add items** opens one dialog with a fixed width and a fixed list height, so it doesn't change size while the editor types or results load.

- A **Source** select lists each collection that isn't marked hidden, each taxonomy, **Archive pages**, **Custom link** and **Heading**. The dialog opens on the last source used in this browser.
- A search field searches the collection on the server, or filters terms and archives in the browser. A collection lists its first 50 entries, and search finds the rest. Results load with skeleton rows.
- Each result has a checkbox, its title, its slug and a draft label when it's a draft. Picks stay checked while the editor switches sources.
- **Custom link** shows Label and URL fields and **Add to list**, which adds the link to the picks. **Heading** shows a Label field and adds a custom item without a URL.
- The footer has an **Add to** select, with **Top level** and then every item that can take children, indented by depth. **Add item inside** opens the dialog with that item already chosen. The footer also shows "3 selected" and the **Add 3 items** button.

Confirming creates the items in the order they were picked, under the chosen parent, and shows one toast: "Added 3 items".

**Editing an item.** The Edit dialog has these fields:

- **Label**.
- **URL**, for a custom link or a heading. A heading's URL is empty, and entering one turns the heading into a link.
- **Links to**, a read-only summary for an entry, archive or term, with its icon, title, path and status badge.
- **Open in new tab**, except on headings. Turning it off clears the item's target.
- **CSS classes**.

The **Parent** select goes away, because dragging and the "⋯" menu set an item's place.

**Empty menu.** A menu with no items shows a small drawing of a site header with an empty slot, "No menu items yet", "Add pages, posts, categories, or links to build this menu." and **Add items**.

### The Menus list

Menus show as cards in a grid of columns at least 18rem wide, as many as the page fits. Each card has:

- a drawing of a small site whose header shows the menu's top-level items, in order, with a caret on items that have children. The first item is highlighted, and a menu with no items shows an empty slot;
- the menu's label, up to two lines, as a link to its editor that covers the whole card;
- the item count, after the sidebar's Menus icon, and the menu's name, after a code icon. Hovering the name shows the text Themes load this menu with getMenu("primary"), with the menu's name. The count is left out when the API doesn't return one, instead of showing "0 items";
- the locale badge, on multilingual sites;
- a "⋯" menu with **Edit** and **Delete**. Delete opens the existing confirmation.

A card loads its menu's items when it comes within one screen height of the viewport, so a long list doesn't load every menu at once. The menu editor reads the same cached response.

With no menus, the page shows the same empty-slot drawing, "No menus yet", "Menus hold the links in your site's header, footer and sidebars. Create one, then add pages, posts and links to it." and **Create Menu**.

### Small screens, long names and right-to-left

- Labels take the row first. The destination fills the space that's left and disappears when less than 4rem remains, so a long label never shares the row with a cut-off "/…".
- When the list is narrower than 36rem, status badges shorten to "Draft", "In trash" and "Not found".
- A cut-off label or destination shows its full text on hover.
- Labels, menu names and the parent options in **Add to** keep their own text direction, so a Latin label in an Arabic admin, or an Arabic label in an English one, keeps its word and punctuation order.
- At 320px wide the list keeps every row's "⋯" menu on screen, and the Menus list shows one card per row.

## Goals

- Add entries, terms, archive pages, custom links and headings from one dialog, several at a time, under a chosen parent.
- Reorder and nest items by dragging, by keyboard, and from each row's menu.
- Show where every item goes, and flag items the site leaves out.
- Make menus on the Menus list recognizable by their contents.
- Support phone widths, right-to-left languages, screen readers and keyboard users.

## Non-goals

- Changes to the REST API, the MCP server, stored data or how the site renders menus.
- Changing an existing item's target, or turning a link into a heading. The update API doesn't accept `type`, `referenceCollection` or `referenceId`, and can't clear `customUrl`. Editors delete the item and add a new one.
- Resolving item targets on the server. The admin resolves them in the browser. See Open questions.
- A depth limit stored on the menu or set by the theme.
- Staged edits with one Save button. Each add, edit, delete and reorder saves at once, as it does today.
- Changing `ContentPickerModal`, which reference fields still use.

## Interfaces and compatibility

- **Public interfaces.** None. There's no new configuration, API route, stored data or exported component. The editor uses the existing create, update, delete and reorder item routes.
- **Requests.** Resolving targets adds admin requests, all on logged-in admin routes:
  - one `GET /_emdash/api/content/{collection}/{id}` per item that links to an entry, cached for a minute and shared between rows;
  - when that returns 404, one trash list request for the collection, to tell "In trash" from "Not found";
  - one taxonomy definitions request on every editor load, which the rows and the **Add items** dialog share;
  - one terms request per taxonomy that the menu's term items use, or for every taxonomy when a term item was saved without its taxonomy name;
  - on the Menus list, one `GET /_emdash/api/menus/{name}` per card as it nears the viewport.

  Anonymous page renders don't change, so the logged-out query count doesn't change.

- **Depth.** The API accepts any depth, and menus created through the API or MCP can be deeper than three levels. The editor shows those items at their depth but never moves an item below the third level. Lifting an item that sits deeper and dropping it in place moves it up to the third level. A parent whose own subtree is already three or more levels deep can only be dropped at the top level.
- **Custom link fields at creation.** The old custom link dialog set the link's target and CSS classes when it was created. The new dialog takes a label and URL, and **Open in new tab** and **CSS classes** are set from the Edit dialog afterwards.
- **Opening in a new tab.** Choosing "Same window" in the old Edit dialog sent no target, so a link that opened in a new tab couldn't be switched back. Turning **Open in new tab** off clears the target.
- **Translations.** New strings come from the rows, the two dialogs, the empty states, the status badges and the drag announcements. These strings become unused in the catalogs: "Add Content", "Add Custom Link", "Edit Menu Item", "Edit menu items", "No parent (top level)", "Target", "Same window", "New window", "CSS classes:", " (opens in new window)", "Order saved", "Menu order has been updated.", "Item added", "Menu item has been added.", "Couldn’t add the menu item", "Change this item's label, link and place in the menu.", "Link to any page by its address, on this site or another.", "Add links to build your navigation menu", "Create your first navigation menu to get started" and "Delete {0} menu". "Parent" stays, because the taxonomy term editor uses it.
- **Tests and baselines.** The Menus browser tests and the menu helpers in `e2e/fixtures/admin.ts` find controls the redesign removes: **Add Custom Link**, the card's "Delete {name} menu" button, the bordered item rows and their buttons, and the card's trash icon. They move to the new controls. The visual regression tests for the Menus page need new left-to-right and right-to-left baselines.

## Errors and edge cases

- **Partial add.** Items are created one at a time. If a request fails, the items already created stay in the menu and leave the picks, the rest stay picked, and the dialog stays open with the server's error.
- **Overlapping reorders.** Two quick moves send two reorder requests. When one fails, the editor reloads the menu, so the list shows what the server saved.
- **Unknown targets.** An entry that returns 404 and isn't in the trash shows "Not found". The trash check reads only the first 100 entries in the collection's trash, so an entry further down that list shows "Not found" instead of "In trash". A term that no longer exists shows "Not found". While a target loads, and when its request fails for any reason other than 404, the row shows its label and icon without a destination or badge.
- **Multilingual sites.** The admin resolves targets in the browser and doesn't apply every rule the site uses, so on some sites a row can disagree with the site:
  - an entry's path comes from its URL pattern and slug, without the site's locale prefix or trailing-slash setting;
  - an entry is looked up by the stored id, while the site renders the best published translation for the menu's locale, so a row can say "Draft" when the site shows a published translation;
  - terms are looked up in the menu's locale only, while the site falls back to another locale's term, so a row can say "Not found" for a term the site renders.

  Server-resolved targets, in Open questions, would remove these differences.

- **Orphaned items.** An item whose parent no longer exists shows at the top level, where the site renders it.
- **Cycles.** Items in a `parentId` cycle from older writes don't show in the editor or on the site, and reorders leave them out.
- **Deleting a parent.** The confirmation says the item's nested items are removed with it.
- **Duplicate labels.** Two items with the same label show their destinations in the list, but the **Add to** select shows labels only.

## Verification

- Component tests for the editor cover each row kind and its destination, the status badges, the "⋯" menu's moves and their disabled states, adding several items from mixed sources under a parent, a partial add failure, a failed reorder, editing each item kind, turning a heading into a link, deleting a parent, and the empty state.
- Unit tests for the tree helpers cover the reorder payload after a drop, sideways depth changes clamped to three levels, children moving with their parent, items deeper than three levels, and orphaned and cyclic data.
- A keyboard test lifts a row, moves and nests it with the arrow keys, drops it, and checks the request and the announcement. The same test runs in a right-to-left layout with the left and right keys swapped.
- Component tests for the Menus list cover the preview's top-level items, a missing item count, the "⋯" menu's Delete confirmation and the empty state.
- Browser tests add, nest, reorder and delete items through the new controls, reload, and check that the order persisted.
- Manual checks in light and dark mode, in Arabic, at 320px, at 200% text size, and with the prototype's worst-case data: long and unbroken labels and URLs, emoji, HTML-like text, a 250-item menu and 120 menus.

## Open questions

- **Server-resolved targets.** The admin menu GET could return each item's resolved title, URL and visibility, resolved the way the site resolves them, in one batched query per type. The menu list could return each menu's top-level labels. Both are additive and logged-in only. They would replace the per-row and per-card requests and the multilingual differences above. Should they be part of this plan or a follow-up?
- **Depth limit.** Is three levels the right fixed limit for the editor, or should a theme or the menu set it?
- **Retargeting items.** Should a follow-up let the update API change an item's target and clear `customUrl`, so the Edit dialog can offer **Change…** instead of delete and re-add?
