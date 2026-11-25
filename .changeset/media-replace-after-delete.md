---
"emdash": patch
---

Fixes `PUT /_emdash/api/media/{id}/replace` storing a file for a media item that was deleted while the replacement was still uploading. The route now checks the item again once the upload has arrived and responds with `404` if it is gone. If the item is deleted while the new file is being written, the route removes that file.
