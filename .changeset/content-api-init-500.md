---
"emdash": patch
---

The content API now answers 500 NOT_CONFIGURED instead of 401 UNAUTHORIZED when the EmDash runtime failed to initialize. Previously the permission check ran first, so a server fault (broken DB binding, init failure) was reported as an authentication error even for requests carrying a valid token — and retry logic correctly treating 4xx as non-retryable gave up instead of retrying. The 13 affected content routes now check initialization before permissions, matching the schema routes.
