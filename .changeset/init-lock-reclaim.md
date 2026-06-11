---
"emdash": patch
---

Fixed a bug where a visitor disconnecting at the wrong moment during a cold start could leave that server instance permanently broken: every subsequent request to it would hang until the platform timed it out (a 524 error on Cloudflare, after 100 seconds), and the instance stayed broken until it was recycled. Sites no longer get stuck — startup now recovers automatically, and in the worst case a request fails fast with an error instead of hanging.
