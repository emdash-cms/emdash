---
"emdash": patch
---

Fixes comment submissions bypassing Turnstile: when the `EMDASH_TURNSTILE_SECRET_KEY` (or `TURNSTILE_SECRET_KEY`) environment variable is set, the public comment endpoint now verifies the submitted Turnstile token server-side and rejects submissions without a valid one. Sites without a configured secret key are unaffected.
