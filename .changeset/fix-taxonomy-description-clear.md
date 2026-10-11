---
"@emdash-cms/admin": patch
---

Fixes clearing an existing taxonomy term description in the admin so the saved value is removed instead of preserved.

Editing a tag, category, or custom taxonomy term and deleting the optional Description text now sends `description: ""` in the update request, so the server clears the stored value. Previously the empty field was converted to `undefined` and dropped from the request body, leaving the previous description in place.
