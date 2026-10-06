---
"@emdash-cms/admin": patch
---

Fixes the error message on the invite and signup pages ending in a bare colon when the server responds with an error page instead of an error message. The message no longer includes the HTTP status text, which browsers leave empty over HTTP/2 and HTTP/3, and it can now be translated.
