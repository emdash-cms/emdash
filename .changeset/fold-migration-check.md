---
"emdash": patch
---

When using auto migration mode, cold starts on an already-migrated database no longer spend a separate database round trip on the migration check: on backends with a coalescing dialect (D1, Durable Object SQL), the applied-migration count is read in the same batch as the other startup reads.
