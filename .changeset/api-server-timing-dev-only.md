---
"emdash": patch
---

Updates production responses from `/_emdash/api` routes to omit the `Server-Timing` header, so query counts and durations no longer vary between API requests that otherwise get the same answer. Pages and the admin still send the header, and `astro dev` still sends it on API responses.
