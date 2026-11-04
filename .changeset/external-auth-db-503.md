---
"emdash": patch
---

Returns a generic `503 Service Unavailable` (with `Retry-After: 60` and `Cache-Control: private, no-store`) instead of `401 Authentication failed` when external authentication such as Cloudflare Access succeeds but the local user lookup, provisioning, or sync fails, for example because database migrations have not been applied. Rejected identities still return 401.
