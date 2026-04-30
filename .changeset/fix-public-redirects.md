---
"emdash": patch
---

Fixes redirect middleware so 301/302 rules from `_emdash_redirects` actually fire for unauthenticated visitors. Previously, the lookup was silently skipped on the public-visitor branch because `locals.emdash.db` is intentionally omitted there — only logged-in admins, edit-mode sessions and preview tokens ever saw redirects (so WordPress migration 301s, manual rewrites and `Auto: slug change` rows did nothing for real traffic, and `hits` / `_emdash_404_log` stayed at zero). The middleware now falls back to `getDb()` (ALS-aware) when `locals.emdash.db` is absent. Resolves #808.
