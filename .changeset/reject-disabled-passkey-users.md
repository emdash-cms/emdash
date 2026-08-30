---
"@emdash-cms/auth": patch
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes disabled accounts being able to complete passkey sign-in. Rejected attempts no longer update passkey usage or create an admin session, and the admin shows a localized authentication error.
