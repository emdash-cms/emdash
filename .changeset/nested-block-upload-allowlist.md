---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes uploads into image and file fields inside blocks ignoring the nested field's `allowedMimeTypes`. Allowed Word documents and other types outside the default upload list can now be uploaded directly from a block's media picker.

API clients uploading into a block field can send `blockType` (the block type slug) and `blockVersion` (the block's version number) with the composite `fieldId` (`<outerFieldId>:<blockKey>:<fieldSlug>`) to `POST /_emdash/api/media` or `POST /_emdash/api/media/upload-url`. Use the database ID of the collection's blocks field for `outerFieldId`, and send `blockVersion` as a string in multipart requests or a number in upload-URL JSON requests. Without the block context, the default upload allowlist still applies.
