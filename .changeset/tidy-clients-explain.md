---
"emdash": patch
---

Fixes `EmDashClient` errors losing plain-text response bodies from runtimes and proxies. Non-JSON error messages now include the first 500 characters of the trimmed body, falling back to the HTTP status text or status code when the body is empty or unreadable.
