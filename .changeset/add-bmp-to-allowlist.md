---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes BMP uploads failing with `File type not allowed`. `image/bmp` was missing from the default media upload allowlist, so a `.bmp` file was rejected before it ever reached storage — the same shape of bug as the earlier AVIF regression (#2683). BMP is a plain raster format with no active-content risk, so it carries the same safety profile as PNG/GIF/WebP/AVIF and needed no security tradeoff to add.

`image/bmp` is now accepted by the upload routes (`POST /_emdash/api/media`, `POST /_emdash/api/media/upload-url`) and the MCP `media_upload` tool, which all read the same allowlist. `.bmp` also works as extension shorthand in a field's own `allowedMimeTypes`, matches the "Images" preset in the allowed-types editor, and appears in the admin upload dialog's file picker and thumbnail preview. Uploaded BMP files render inline (`Content-Disposition: inline`) like other safe raster types instead of being forced to download.
