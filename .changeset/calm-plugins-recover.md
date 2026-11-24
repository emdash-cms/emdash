---
"emdash": patch
---

Fixes plugin routes staying unavailable on Cloudflare after a request is cancelled during storage index synchronization. Later requests can recover without restarting the server.
