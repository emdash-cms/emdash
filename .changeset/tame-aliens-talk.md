---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the entry editor’s OG Image preview showing “Image not found” for SEO images stored as bare media IDs. The public `/_emdash/api/media/file/:key` endpoint now accepts ready media IDs as well as storage keys, so anyone with a media ID can retrieve its file even when the storage key differs from the ID. Backup and transfer storage keys remain inaccessible through this endpoint.
