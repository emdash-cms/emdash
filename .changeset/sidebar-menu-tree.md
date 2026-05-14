---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds sidebar menu tree with collection grouping, plugin subgroups, and public menu sync. Collections can now be organized into collapsible sidebar groups via a new `group` field and ordered with `sortOrder`. Plugin admin pages support the same grouping and custom icon resolution (25+ Phosphor icons). The sidebar supports one level of nested submenus and can hide unused core features via `hideCoreFeatures` / `hideCollections` config. New menu sync engine auto-populates public menus from sidebar structure on collection creation, with preview (`GET /_emdash/api/menus/:name/sync-diff`) and apply (`POST /_emdash/api/menus/:name/sync`) endpoints. Drag-and-drop reordering UI added to the Content Types admin page.
