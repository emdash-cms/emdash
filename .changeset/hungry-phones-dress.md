---
"emdash": patch
---

Fixes plugin storage-index synchronization so a fresh runtime cannot serve state-changing plugin routes before the declared indexes are materialized, and so a partially failed synchronization remains retryable in the same process after the underlying conflict is corrected.
