---
"@emdash-cms/auth": patch
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes disabled accounts being able to complete passkey, Magic Link, OAuth, or Atmosphere sign-in. Authentication attempts are rejected before credential usage, OAuth account links, invite acceptance, or login sessions are recorded.
