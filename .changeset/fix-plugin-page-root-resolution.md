---
"@emdash-cms/admin": patch
---

Fixes plugin admin pages showing a Plugin Error when opened from the Plugin Manager. The Settings gear opens a plugin at its root (`/plugins/<id>/`), but a plugin that registers its page at `/settings` rather than `/` had no page there, so the admin fell through to a 404. Plugin page resolution now resolves the plugin root to the first registered page and treats `/settings` and `/settings/` as the same path, so a single registration works from the Plugin Manager gear and the sidebar regardless of trailing slash.
