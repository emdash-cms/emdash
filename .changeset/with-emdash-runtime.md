---
"emdash": minor
---

Adds `withEmDashRuntime()` to `emdash/middleware` so request-free handlers (Cloudflare Queue consumers, custom `scheduled()` handlers) can access the EmDash runtime and invoke plugin routes directly — previously the runtime was only reachable through `locals.emdash` on an HTTP request.
