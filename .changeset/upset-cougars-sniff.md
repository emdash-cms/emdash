---
"emdash": minor
---

Adds save-side MIME validation for `file` and `image` fields with `allowedMimeTypes` constraints. Content creates and updates now reject media references whose MIME type is not in the field's allowlist, returning `INVALID_MIME_FOR_FIELD`.
