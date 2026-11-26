---
"emdash": patch
---

Fixes S3 signed media uploads so a confirmed file can no longer change afterwards. The upload URL from `POST /_emdash/api/media/upload-url` stays valid for an hour, and confirming the upload kept the file at the key that URL writes, so a later upload to the same URL replaced the confirmed file. Confirming a signed upload, through `POST /_emdash/api/media/{id}/confirm` or the MCP `media_create` tool, now copies the file to a new storage key and makes the item ready under that key.

The confirmed item's `storageKey` and `url` therefore differ from the `storageKey` in the upload URL response, as they already did for uploads sent through EmDash. Clients should use the values from the confirm response. Storage adapters can implement the new optional `copy()` method to copy files inside the storage service, as the S3 adapter does; adapters without it download and re-upload the file.
