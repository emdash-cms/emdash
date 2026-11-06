---
"@emdash-cms/admin": patch
---

Fixes non-admin users being able to open admin-only screens in the admin UI. A non-admin who opens a site-level settings page, **Users**, **WordPress import**, or a plugin's settings page by its URL now sees an "Access denied" message instead of a screen that fails to load or cannot save. The **Settings** screen stays open to every role and lists only the pages that role can use.

#### Changes for Editors

Editors could previously open **Settings → General**, **Social Links**, and **SEO** and read their values, although saving them already required an administrator. They can no longer open these pages.
