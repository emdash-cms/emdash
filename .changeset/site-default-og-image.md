---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds support for a site-wide default Open Graph image. The setting is exposed in the admin SEO settings page (Settings -> SEO -> Default Social Image), resolved to a URL on read by `getSiteSettings()`, and automatically emitted as `og:image` / `twitter:image` (and BlogPosting JSON-LD `image`) by `EmDashHead.astro` whenever a page has no image of its own. Per-page images still take precedence.

This wires up an existing data model that was previously defined in the schema and MCP tools but never used: stored values were not resolved and no template path read the setting.

Emitted URLs are absolutized using `SiteSettings.url`, the page's `siteUrl`, or the request origin so crawlers and JSON-LD consumers that reject relative URLs work correctly.

Also adds a `localOnly` prop to `MediaPickerModal` that suppresses the "Insert from URL" input and external provider tabs. Used by SEO settings to ensure the picker only returns locally-stored media (since the setting only persists a local `mediaId`).

Media metadata updates and deletes now invalidate the worker-scoped site-settings cache, so resolved logo/favicon/default-social-image URLs and dimensions stay in sync with the underlying media row.
