---
"emdash": minor
---

Updates the MCP content tools and revision restore to honor an entry's edit lock, so an AI tool connected over MCP no longer overwrites an entry that someone else has open in the admin.

`content_update`, `content_delete`, `content_publish`, `content_unpublish`, `content_schedule`, `content_unschedule`, `content_discard_draft` and `revision_restore` fail with `ENTRY_LOCKED` while another user holds the entry's lock, where the call used to succeed. The error message names the holder, and `_meta.details` carries their `userId`, `userName`, `acquiredAt` and `expiresAt`. Reading the item again does not clear the refusal. Each of these tools takes an optional `overrideLock: true` to write anyway.

`POST /_emdash/api/revisions/{revisionId}/restore` now returns `409 ENTRY_LOCKED` in the same case. Pass `"overrideLock": true` in the request body to restore anyway.

To keep the previous behavior for a whole collection, switch edit locking off for it under **Content Types** → your collection → **Edit locking**.
