---
"emdash": patch
---

Fixes redirect hit counts and 404 log entries that Cloudflare Workers could drop when the response was sent before the write finished. The Worker now stays alive until these writes complete, and a failed write is logged with a `[redirects]` prefix instead of being discarded silently.
