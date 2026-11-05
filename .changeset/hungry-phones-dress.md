---
"emdash": patch
---

Fixes plugin storage-index synchronization so a fresh runtime cannot serve state-changing plugin routes before the declared indexes are materialized. These routes return `503 STORAGE_INDEXES_NOT_READY` if synchronization is incomplete. After correcting the underlying conflict, a subsequent write request or scheduled maintenance pass retries synchronization without a process restart. GET and HEAD plugin routes do not trigger index synchronization.

When stored indexes match the plugin's declarations, a cold runtime checks them once without reissuing index statements. Updating or reinstalling a runtime-installed plugin rechecks its declarations before its next state-changing route runs. While a conflict remains, each subsequent write request retries the plugin's full index synchronization and returns 503. Correct the conflicting data before retrying to avoid repeated index work.
