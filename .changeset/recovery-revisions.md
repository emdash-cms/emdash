---
"emdash": minor
---

Adds recovery revisions, which keep a copy of an editor's unsaved fields in an entry's revision history without changing the entry. Save one with `POST /_emdash/api/content/{collection}/{id}/revisions` and a body of `{ "data": { ... }, "slug": "..." }`, where `slug` may be `null`.

- The route needs a signed-in session, not an API token, and edit access to the entry. It works for entries in Trash, accepts up to 1.9 MB of fields, and responds with the new revision's `id`.
- The revision is stored as sent, without field validation or `content:beforeSave`, and changes neither the draft nor the published version. Restoring it saves its fields and slug as an edit by the restoring user, so validation and `content:beforeSave` run then.
- Site export leaves recovery revisions out.
