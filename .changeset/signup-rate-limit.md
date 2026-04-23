---
"emdash": patch
---

Rate-limits the self-signup request endpoint to prevent abuse. `POST /_emdash/api/auth/signup/request` now allows 3 requests per 5 minutes per IP, matching the existing limit on magic-link/send. Over-limit requests return the same generic success response as allowed-but-ignored requests, so the limit isn't observable to callers.
