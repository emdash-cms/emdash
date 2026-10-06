---
"emdash": patch
---

Fixes `parseApiResponse` from `emdash/plugin-utils` rejecting with an error message that ends in a bare colon when a plugin route responds with an error page instead of an error message. The message is now the fallback message alone, without the HTTP status text, which browsers leave empty over HTTP/2 and HTTP/3.
