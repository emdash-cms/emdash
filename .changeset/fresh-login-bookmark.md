---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes intermittent logged-out bounces immediately after login, signup, or invite acceptance on D1 and Durable Object databases with read replication enabled. The request that establishes the session now persists its read-replica bookmark, so the next request sees the newly created user instead of querying a replica that hasn't caught up yet.
