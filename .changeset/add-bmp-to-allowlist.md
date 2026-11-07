---
"emdash": patch
"@emdash-cms/admin": patch
---

Accepts BMP images in the Media Library. Uploads through the admin, the media API, and the MCP `media_upload` tool no longer fail with `File type not allowed`. BMP files show as thumbnails in the upload dialog, are included in the "Images" preset of the allowed file types editor, and are displayed in the browser instead of downloaded. Fields with their own `allowedMimeTypes` can list them as `.bmp`.
