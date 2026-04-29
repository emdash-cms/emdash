---
"emdash": patch
---

Fixes migrations 034 and 035 so they can safely re-run when a previous attempt left the schema partially applied without recording it in `_emdash_migrations`. Resolves the "index already exists" error reported on upgrade from 0.1.1 to 0.6.0+.
