---
"@emdash-cms/cloudflare": patch
---

Fixes playground retries reusing a partially initialized database after setup fails, which could make every retry return another 500 error. Trying again now discards the incomplete session and creates a fresh playground database.
