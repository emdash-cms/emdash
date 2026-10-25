---
"emdash": patch
---

Fixes plugin storage-index synchronization so a fresh runtime cannot serve state-changing plugin routes before the declared indexes are materialized. These routes return `503 STORAGE_INDEXES_NOT_READY` if synchronization is incomplete. After correcting the underlying conflict, a subsequent write request or scheduled maintenance pass retries the missing indexes without a process restart. GET and HEAD plugin routes do not trigger index synchronization.
