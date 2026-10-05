---
"emdash": patch
---

Fixes missing redirect hit counts and 404 log entries on Cloudflare Workers. The Worker could stop before these writes finished. It now stays alive until they complete, and a failed write is logged with a `[emdash:redirects]` prefix.
