---
"emdash": patch
---

Fixes WXR import not preserving original post dates or publish status. Uses `wp:post_date_gmt` (UTC) with fallback chain to `pubDate` (RFC 2822) then `wp:post_date` (site-local). Handles the WordPress `0000-00-00 00:00:00` sentinel for unpublished drafts. Sets `published_at` for published posts. Applies to both WXR file upload and plugin-based import paths.
