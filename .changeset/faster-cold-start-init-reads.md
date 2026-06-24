---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Cuts cold-start latency by batching runtime initialization reads into a single round trip. On a fresh isolate (or Worker), the auto-seed check, plugin-state load, and site-info load now run as one batched query on backends that support it (Cloudflare D1, Durable Objects) instead of several serialized round trips. On D1 this roughly halves runtime init time on cold start. Other backends (Node/SQLite) are unaffected.
