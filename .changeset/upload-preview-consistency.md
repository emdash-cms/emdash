---
"@emdash-cms/admin": patch
---

Fixes a broken preview while uploading images the browser can't display, such as HEIC or TIFF files, dropped or pasted into the Portable Text editor. The editor now follows the Media Library upload list: files over 8 MB, or in formats other than JPEG, PNG, GIF, WebP and AVIF, upload with a plain placeholder instead of a preview. The featured and Open Graph image fields now use the same "Only image files can be uploaded here." message as the editor. Screen readers no longer hear an extra "Loading" announcement while an image uploads into those fields.
