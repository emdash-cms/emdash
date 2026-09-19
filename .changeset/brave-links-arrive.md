---
"@emdash-cms/auth": patch
"emdash": patch
---

Fixes email-verification signup, which could not be completed: the verification email linked to the JSON API endpoint instead of the signup page, the signup page itself redirected anonymous visitors to login, and that redirect dropped the `?token=` from the URL. The email now links to `/_emdash/admin/signup?token=…` (as the invite email already did), the page is reachable without a session, and the login redirect preserves the query string of the page it returns to.
