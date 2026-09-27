---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an `admin.quickCreate` collection setting that removes the collection's "new entry" quick action from the admin dashboard. Set it to `false` in a seed file or through the schema API, or turn off "Quick action on the dashboard" in the content type editor's Navigation section. Collections without the setting keep their quick action. A schema API update replaces the whole `admin` object, so include any existing `admin.listColumns` in the same request.
