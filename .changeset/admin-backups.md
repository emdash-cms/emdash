---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": patch
---

Adds a Backups page to admin settings: download a complete content backup (all content including drafts and trash, schema, taxonomies, menus, widgets, media metadata, and site settings — never user accounts or secrets) with one click, and optionally enable daily automatic backups to the site's storage bucket with configurable retention. A new `backups:manage` permission gates the feature to admins.
