---
"emdash": patch
---

Stops a WordPress exporter import with the bot-protection message when Cloudflare challenges a request for taxonomies, menus, site settings, or the media list. Previously the import skipped that part without telling you and finished without it. The analyze and execute endpoints now return `WP_SITE_CHALLENGE` with status 502 in these cases too.
