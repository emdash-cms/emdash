---
"emdash": patch
---

Run `media:beforeUpload` and `media:afterUpload` hooks for admin signed-URL uploads. The `POST /_emdash/api/media/upload-url` endpoint now invokes `media:beforeUpload` before creating the pending upload, and `POST /_emdash/api/media/{id}/confirm` invokes `media:afterUpload` after the media item becomes ready.
