---
"emdash": patch
---

Updates the MCP `media_create` tool to complete pending signed uploads. Pass the `storageKey` returned by `POST /_emdash/api/media/upload-url` after uploading the file. Confirmation uses the same user and the file size supplied when the upload URL was issued.

Media deletion and abandoned-upload cleanup preserve stored objects while another media record references the same key.
