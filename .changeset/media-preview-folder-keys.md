---
"@emdash-cms/admin": patch
---

Fixes the admin editor showing "Image not found" for local media whose storage key contains a folder, such as `2026/08/photo.jpg`. Image fields, featured images, galleries and the asset editor now request `/_emdash/api/media/file/2026/08/photo.jpg` instead of `2026%2F08%2Fphoto.jpg`, which the file route answered with 404. Query and fragment characters in a key are still encoded.
