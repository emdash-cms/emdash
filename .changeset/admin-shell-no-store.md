---
"emdash": patch
---

Sets `Cache-Control: private, no-store` on the admin shell response so shared caches never store the admin HTML. Without an explicit header, caches that apply RFC 9111 heuristic freshness (for example Cloudflare's Workers Cache) could store an authenticated 200 and replay it to anonymous visitors instead of the login redirect.
