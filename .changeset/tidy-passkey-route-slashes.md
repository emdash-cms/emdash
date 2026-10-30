---
"emdash": patch
---

Fixes passkey login returning “Not authenticated” before the browser can request a passkey when middleware adds trailing slashes to API URLs. Public API routes, including login options and health checks, now accept either spelling while keeping private routes protected and preserving CSRF checks.
