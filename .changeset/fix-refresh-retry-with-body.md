---
"emdash": patch
---

Fixes `emdash content create` and `content update` failing with "Cannot construct a Request with a Request object that has already been used" when the stored access token has expired. Requests carrying a body are now retried correctly after the token is refreshed.
