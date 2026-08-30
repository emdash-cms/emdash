---
"@emdash-cms/auth": patch
"emdash": patch
---

Fixes disabled accounts being able to complete passkey sign-in. Rejected attempts no longer update passkey usage or create an admin session.
