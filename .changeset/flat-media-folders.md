---
"emdash": minor
---

Adds flat media folders to the `emdash` REST and typed client APIs. Existing media remains in the
Main library after upgrade, so sites do not need to migrate media assignments.

- Includes database migration `072_media_folders`.

Use `GET` or `POST /_emdash/api/media/folders` to list or create folders, and `PUT` or
`DELETE /_emdash/api/media/folders/:id` to rename or delete them. Folder reads require
`media:read`; folder writes require `media:edit_any`. Typed clients expose the corresponding
`mediaFolderList`, `mediaFolderCreate`, `mediaFolderUpdate`, and `mediaFolderDelete` methods.

Media list requests can filter by a folder ID or use `folderId=unfiled` for the Main library.
Media updates and `mediaSetFolder` accept a folder ID, `null`, or `unfiled`. Authors can assign
their own media, while editors can assign any media.

Deleting a folder returns its media to the Main library without changing media IDs, storage keys,
URLs, or usage records.
