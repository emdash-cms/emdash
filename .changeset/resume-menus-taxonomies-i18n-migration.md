---
"emdash": patch
---

Fixes sites on Cloudflare D1 or SQLite that stay stuck on the `036_i18n_menus_and_taxonomies` migration after a first attempt stopped partway, for example on a slow cold start. Every retry failed with `no such table`, and pages rendered without CMS data. The migration now resumes where it stopped and completes. Content-taxonomy assignments come back intact. On a site that was already stuck at the menus, menu items, taxonomies, or taxonomy definitions table, the earlier retries emptied that table: the migration completes after the update, but those rows have to be restored from a backup, such as D1 Time Travel or a copy of the SQLite database file.
