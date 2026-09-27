---
"emdash": patch
---

Fixes fresh Cloudflare D1 sites remaining partially initialized when the first-request seed is interrupted while creating a collection. The next request now resumes the seed. Existing configured sites and sites initialized with `emdash seed` are left unchanged, so upgrades and cold starts do not recreate deleted sample content. Attempts to create a collection over an orphaned content table now return a specific conflict instead of a generic server error.
