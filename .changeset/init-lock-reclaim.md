---
"emdash": patch
---

Fix isolate-poisoning deadlock in runtime and database initialization. If the request that owned a cold-isolate init was cancelled mid-await (e.g. the client disconnected during migrations), the release in its `finally` never ran, leaving the init guard stuck forever — every subsequent request in that isolate hung until the platform killed it at the wall limit (observed as 524s after 100s) and the isolate was poisoned until eviction. Initialization is now guarded by a reclaimable lock: waiters poll (never awaiting a cross-request promise), a stale owner is reclaimed after a deadline, and waiters give up with an error rather than hanging indefinitely.
