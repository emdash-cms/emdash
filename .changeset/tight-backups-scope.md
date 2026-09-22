---
"emdash": patch
---

Fixes API tokens scoped only to `settings:read` or `settings:manage` being accepted by the backup routes under `/_emdash/api/settings/backups`, including the full-site export. An API token now needs the `admin` scope to use any backup route; other tokens get a 403. Session sign-ins are unaffected.

JSON backups also no longer include `emdash:site_url`, the deployment URL recorded at setup. Site settings, title, tagline, and locale are still included.
