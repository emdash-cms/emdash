---
"emdash": patch
---

Fixes the setup probe redirecting prerendered and public pages to `/_emdash/admin/setup` when D1 transiently reports a missing `_emdash_migrations` table on cold start. Setup redirection is now limited to `/_emdash/*` routes; public pages continue rendering normally.
