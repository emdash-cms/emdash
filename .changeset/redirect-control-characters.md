---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes an open redirect in the admin login page and the logout, magic-link sign-in, and dev-bypass routes: a `?redirect=` value containing a tab, carriage return, or line feed (for example `/%09/evil.example`) could send the browser to another site. Redirect values that contain control characters are now ignored.
