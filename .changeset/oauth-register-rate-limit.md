---
"emdash": patch
---

Fixes anonymous OAuth dynamic client registration (`POST /_emdash/api/oauth/register`) letting unauthenticated visitors create unlimited OAuth client records. Registration is now limited to 10 per minute per client IP. Requests over the limit get a `429` with `Retry-After: 60` and a `temporarily_unavailable` error body. Like the other auth rate limits, it applies only when EmDash can determine the client IP: on Cloudflare, or when `trustedProxyHeaders` (or `EMDASH_TRUSTED_PROXY_HEADERS`) is configured.
