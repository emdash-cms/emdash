---
"emdash": patch
---

Fixes read-only API responses showing users without `content:read_drafts`, such as subscribers, details of unpublished content:

- `GET /_emdash/api/menus/:name`, `GET /_emdash/api/menus`, and the `menu_get` and `menu_list` MCP tools now leave out menu items that link to draft, scheduled or trashed entries, along with the items nested under them, and count only the remaining items in `itemCount`. Subscribers now get the same items the site renders for visitors.
- `GET /_emdash/api/content/:collection/:id/terms/:taxonomy` now returns an empty `unresolved` list to these users, because those assignments can come from an unpublished translation. `terms` is unchanged.
- The content list and single-entry reads, over REST and through the `content_list` and `content_get` MCP tools, no longer return `draftRevisionId`, `version` or `_rev` to these users. Saving or discarding a draft changes these values while the published entry stays the same. These users cannot edit content, so they have no use for `_rev`.

Contributors and above still get the full responses.
