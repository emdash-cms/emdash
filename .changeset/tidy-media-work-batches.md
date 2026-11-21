---
"emdash": patch
---

Fixes excessive D1 load while indexing media usage on large sites. Setup now processes at most 100 entries per step, selects due work through indexed per-state batches on D1, and avoids repeated batch scans when claiming, completing, releasing, or retrying work. Failure logs include the error message and underlying cause, including the original processing error if scheduling its retry also fails. Media usage publication errors on PostgreSQL are preserved when cleanup also fails in an aborted transaction.
