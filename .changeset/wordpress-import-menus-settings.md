---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WordPress WXR import so navigation menus and site identity actually land in the target site. Menu items (`nav_menu_item` posts) were previously discarded, and the channel `<title>`/`<description>` were parsed but never written to settings, so imported sites came up without menus and with no site title. The analyzer now surfaces `navMenus` and a detected `homePageSlug`, and the execute endpoint honors the `importMenus` and `importSiteSettings` config flags the admin UI already exposes.
