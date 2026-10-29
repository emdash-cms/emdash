---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes uploads into image and file fields inside blocks ignoring their configured `allowedMimeTypes`. Uploads now use the field's retained block version, so allowed Word documents and other file types outside the default upload list can be uploaded directly from the block's media picker.
