---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes media uploads with native R2 storage and waits for uploads to finish before reporting success.
Images larger than 8 MiB skip server-generated placeholders in signed and streamed upload flows.
