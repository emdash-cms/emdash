---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes media uploads with native R2 storage, keeps client-side hashing optional, and prevents deduplication from returning media with a different type or size.
Images larger than 8 MiB skip server-generated placeholders in signed and streamed upload flows.
