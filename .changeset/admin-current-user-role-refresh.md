---
"@emdash-cms/admin": patch
---

Fixes the admin continuing to show or hide actions by a user's old role after an administrator changes that role. The admin now reloads the signed-in user's role when the server refuses a request and when the user returns to the admin tab, instead of keeping the old role for up to five minutes.
