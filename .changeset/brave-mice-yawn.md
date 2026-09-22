---
"emdash": patch
---

Fixes magic link verification so email security scanners can no longer consume the one-time token before the recipient clicks the link.

`GET /_emdash/api/auth/magic-link/verify?token=...` now renders an HTML confirmation page instead of immediately verifying the token. The token is only consumed when the recipient submits the form on `POST /_emdash/api/auth/magic-link/verify`, which creates the session and redirects as before.
