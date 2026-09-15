---
"@emdash-cms/admin": patch
---

Fixes non-admin users being able to open admin-only screens in the admin UI. The **Settings** link in the user menu is now shown only to administrators, and a non-admin who opens a site-level settings page, **Users**, **WordPress import**, or a plugin's settings page by its URL now sees an "Access denied" message instead of a screen that fails to load or cannot save.

#### Changes for Editors

Editors could previously open **Settings → General**, **Social Links**, and **SEO** and read their values, although saving them already required an administrator. They can no longer open these pages. The **Settings** screen is also where the admin language is chosen, so Editors and other non-admins now choose the admin language on the sign-in screen.

**Security** settings, where each user manages their own passkeys, remain available to every role from the user menu.
