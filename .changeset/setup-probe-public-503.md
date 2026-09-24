---
"emdash": patch
---

Fixes public pages redirecting visitors and crawlers to `/_emdash/admin/setup` when the database has never been migrated. With the default automatic migration mode, the first public request now migrates the database and renders the page. If that fails, the page answers with a temporary uncached `503` that links to the setup wizard. Opening `/_emdash/admin` on a new site still leads to the setup wizard.
