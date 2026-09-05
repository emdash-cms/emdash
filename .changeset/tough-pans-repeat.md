---
"emdash": patch
---

Fixes Cloudflare D1 sites that could never finish migrating after migration 017 was interrupted. Every retry failed with `table "_emdash_authorization_codes" already exists`; the migration now skips the statements that already ran.
