---
"emdash": patch
---

Fixes a read-your-writes gap with database read replication: the session bookmark cookie is now persisted even when page rendering throws after a successful write, so an immediately-following request can't read pre-write state from a lagging replica.
