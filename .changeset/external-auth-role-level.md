---
"emdash": patch
---

Fixes external authentication, such as Cloudflare Access, saving a role level that EmDash doesn't define to the user record. That user's later sign-ins then failed even after the provider's role mapping was corrected. EmDash now refuses the sign-in without changing the user record, so correcting the mapping restores access.
