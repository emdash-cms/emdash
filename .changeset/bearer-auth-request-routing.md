---
"emdash": patch
---

Treats API-token and OAuth-token (`Authorization: Bearer ec_pat_*` / `ec_oat_*`) requests as authenticated when choosing the request-scoped database connection. These requests carry no session cookie, so they were previously classified as anonymous and could be routed to a read replica (D1) or the query cache (Hyperdrive split caching), breaking read-your-writes for API clients. They now use the primary/uncached connection like session-authenticated requests.
