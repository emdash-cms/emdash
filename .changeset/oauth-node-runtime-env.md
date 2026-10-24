---
"emdash": patch
---

Fixes OAuth sign-in on Node adapters so provider credentials (`EMDASH_OAUTH_*` and provider `*_CLIENT_ID`, `*_CLIENT_SECRET`, and `*_TENANT_ID` values) are read from the runtime environment. Build-time values are only a dev fallback.
