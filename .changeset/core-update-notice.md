---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Adds a core update notice to the admin dashboard: when a newer EmDash version is published to npm, admins see a dismissible banner with a link to the release notes. The registry is checked at most once per day in the background and never blocks a request. Set `updateCheck: false` in your EmDash config to disable the check.
