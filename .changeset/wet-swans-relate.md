---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugin storage writes on Cloudflare so overwrites retain creation timestamps and unique constraint failures preserve existing records.
