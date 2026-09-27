---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/auth": minor
---

Adds a core update notice to the admin dashboard. When a newer EmDash version is available, admins see a dismissible banner with a link to the release notes. The banner names the newest release that has been public on npm for at least 24 hours.

The check is on by default: the server sends a GET request to `https://registry.npmjs.org/emdash` at most once a day, in the background, with no site data. To wait longer before a release is announced, for example to match pnpm's `minimumReleaseAge`, or to turn the check off:

```js
emdash({ updateCheck: { minimumReleaseAge: "7d" } }); // a duration string or seconds
emdash({ updateCheck: false });
```

The banner reads `GET /_emdash/api/admin/core-update`, which requires the new `updates:read` permission (admins only).
