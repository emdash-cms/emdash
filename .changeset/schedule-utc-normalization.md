---
"emdash": patch
---

Fixes `content.schedule()` storing `scheduledAt` with whatever offset the caller supplied (e.g. `+09:00`) instead of normalizing it to UTC. Because `findReadyToPublish()` compares `scheduled_at` against `new Date().toISOString()` (always UTC/`Z`) via plain string ordering, a non-UTC offset sorted incorrectly and published up to that many hours late (or early, for offsets ahead of UTC). `schedule()` now stores `scheduledDate.toISOString()`, the same value it already validates against.
