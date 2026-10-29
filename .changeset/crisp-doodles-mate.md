---
"emdash": patch
---

Fixes `POST /_emdash/api/oauth/token` returning uppercase `INVALID_GRANT` for refresh-token and device-code failures. These responses now use the RFC-standard `invalid_grant` code so OAuth clients can recognize rejected grants and restart authorization.
