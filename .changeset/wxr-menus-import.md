---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WordPress export file (WXR) imports leaving out menus. The admin said the WXR path imports menus, but the import created none, and the review screen didn't list them. The review screen now lists a file's menus by their names in WordPress, with the switch that exporter imports already have, and the import creates them with their nesting and with links to the imported pages and posts. An item without its own label shows the linked entry's title, as in WordPress. On a site translated with Polylang or WPML, each menu takes the language of the pages it links to. Items that link to a category or tag archive, or to content the import left out, are skipped and counted in the import result, and a menu that already exists under the same name and language is left as it is.
