---
"emdash": patch
---

Fixes plugin routes on Cloudflare staying broken with the error "This promise was created by a request that has since ended, so it can never settle" after cancellation during storage index checks or creation. Later requests can recover, and requests that wait too long for synchronization receive a `503 STORAGE_INDEXES_NOT_READY` response instead of hanging.

If cancellation interrupts an index removal whose outcome remains unknown, state-changing plugin routes stay blocked with 503. If its response never settles, this block lasts for the runtime's lifetime and a restart is required to clear it. Automatic recovery from an abandoned destructive schema operation is not included.
