---
"emdash": patch
---

Fixes plugin routes on Cloudflare staying broken until restart with the error "This promise was created by a request that has since ended, so it can never settle" after a request is cancelled during storage index synchronization. Later requests can recover on their own, and requests that wait too long for synchronization receive a `503 STORAGE_INDEXES_NOT_READY` response instead of hanging.
