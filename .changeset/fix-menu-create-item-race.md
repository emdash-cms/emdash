---
"emdash": patch
---

Fixes a race in `MenuRepository.createItem` when `sortOrder` is omitted. The read of `max(sort_order)` and the subsequent insert now run in a single transaction, preventing two concurrent calls from computing the same next index.
