---
"emdash": patch
---

Fixes URLs for entries whose slug contains a slash, such as a page with the slug `about/team` in a collection with the URL pattern `/{slug}`. Menus, sitemaps, canonical and hreflang links, preview and "View published" links, and the redirects created when a slug changes now use `/about/team` instead of `/about%2Fteam`. Other characters in each segment are still URL-encoded.
