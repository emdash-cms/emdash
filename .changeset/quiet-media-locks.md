---
"emdash": patch
---

Fixes concurrent content saves failing with hung-request errors on Cloudflare Workers when updating media usage. Later saves can also recover if an earlier request was cancelled while holding a media-usage lock, rather than leaving writes to the collection stuck until the isolate restarts. A save may wait up to a minute before reclaiming an abandoned lock.
