---
"@emdash-cms/plugin-atproto": patch
---

Fixes missing standard.site cover images and Bluesky link-card thumbnails for posts using `data.featured_image`. Local media is read directly from storage rather than fetched from the site's public URL. The plugin now requests the `media:bytes:read` permission; approve it when updating the plugin.

Skipped images now show a warning in Recent Syncs on the AT Protocol settings page without preventing text syndication. Images must be no larger than 1,000,000 bytes; automatic resizing is not available.
