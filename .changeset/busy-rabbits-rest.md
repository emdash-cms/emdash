---
"@emdash-cms/cloudflare": patch
---

Fixes Cloudflare Access logins without identity-provider groups, such as one-time PIN logins, failing when `roleMapping` is configured. These logins now receive `defaultRole` (30 if not configured).
