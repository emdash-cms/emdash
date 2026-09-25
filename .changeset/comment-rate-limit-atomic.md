---
"emdash": patch
---

Enforces the public comment submission rate limit under concurrent requests. Parallel submissions could previously all pass the check before any of them was saved, so a burst could post far more than the allowed 5 comments per 10 minutes per IP address (or 20 in total, shared by all visitors, when the site cannot determine a trusted client IP). The limit now resets at fixed 10-minute boundaries, so up to twice the cap can be accepted in quick succession across a boundary. On sites with Turnstile enabled, only submissions that pass the CAPTCHA count toward the limit. Submissions that pass the rate-limit check but are rejected later, for example by a `comment:beforeCreate` hook, now also count toward the limit. Rate-limited responses now include a `Retry-After` header.
