---
"@emdash-cms/plugin-forms": patch
---

Fixes public form submissions ignoring a file field's maximum file size, which let a visitor upload a file of any size. Submitted files are now checked against the field's `maxFileSize`, and no file can exceed 10 MB, even when the field's limit is higher or unset. Empty files are rejected. A file that fails its field's size or accepted-types check is rejected before any file in the submission is uploaded, and when a later upload fails, the files already uploaded for that submission are deleted.

A file's `bytes` can now be sent as a base64 string, which is about a third larger than the file, instead of as an array of byte values, which is several times larger. Arrays of byte values are still accepted.

Once `emdash` is also updated, file fields accept only PNG, JPEG, GIF, WebP, and AVIF images, video, audio, and PDF files. Submissions with any other file type are rejected with a `415` error, even when the field's accepted types list them, and a file with a malformed content type is rejected with a `400` error.
