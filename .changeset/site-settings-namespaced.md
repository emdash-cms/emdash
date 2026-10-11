---
"emdash": minor
---

Scopes site settings to the server-selected site. Two sites can now use the same setting keys without sharing titles, branding, or display preferences. Existing `site:*` options are migrated to `site:site-default:*`; shared plugin options keep their names and remain installation-wide.

Site-owned settings now require a trusted site ID in request context. Operators using the `seed` or `export-seed` CLI commands must pass `--site-id <id>`. Unscoped site-setting reads and writes fail instead of selecting the default site.
