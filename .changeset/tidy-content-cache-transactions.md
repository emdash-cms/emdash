---
"emdash": patch
---

Fixes stale content persisting in the object cache after PostgreSQL content API updates under concurrent read load. Cache invalidation for content and shared data now waits for managed write operations to finish, so concurrent reads cannot keep old values cached after a transaction commits. On D1, cache refresh waits until the non-transactional write callback finishes, including operations that partially apply before failing.
