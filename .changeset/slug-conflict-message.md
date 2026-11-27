---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the "Failed to save" and "Failed to publish" toasts for a slug that is already taken showing the server's raw English text. They now say another entry in the collection uses the slug, possibly one in the trash, and that the editor can change the slug or permanently delete the trashed entry. The message is translated. A `SLUG_CONFLICT` error from content create, update and publish now carries the slug in `details.slug` when the server knows which slug collided (the one in the request, or the staged one on publish), and the toast names the slug only from there.
