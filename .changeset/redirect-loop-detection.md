---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes redirect loops causing the ERR_TOO_MANY_REDIRECTS error, by detecting circular chains when creating or editing redirects on the admin Redirects page.
