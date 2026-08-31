---
"emdash": minor
"@emdash-cms/plugin-forms": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Add private plugin media uploads and authenticated form attachments. Private objects use a separate editor-only, non-cacheable download route, stay out of general media lists, and remain retryable when storage cleanup fails. Native forms now parse multipart submissions, validate PDF, JPEG, PNG, and MP4 signatures, enforce five-file and size limits, retain authenticated download links, and delete attachment objects with manual or scheduled submission cleanup.
