---
"emdash": patch
---

Fixes saving or publishing an entry on PostgreSQL sometimes failing with "Failed to update content" or "Failed to publish content" because of a database deadlock, when media usage tracking was processing that entry at the same time.
