---
"emdash": patch
---

Fixes excessive D1 load while indexing media usage on large sites. Setup now processes at most 100 entries per step, and claiming, completing, releasing, or retrying work no longer repeatedly scans the batch for every queued entry. Failure logs include the error message and underlying cause, including the original processing error if scheduling its retry also fails.
